-- ─────────────────────────────────────────────────────────────────────────
-- Fix eliminar_tenant_completo: deshabilitar triggers cache durante cleanup
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug descubierto 24-may noche corriendo audit defensivo (bloque A).
-- TODA la suite E2E full estaba fallando en CI desde el sprint 23-may con:
--   "update or delete on table 'tenants' violates foreign key constraint
--    'saldos_caja_tenant_id_fkey' on table 'saldos_caja'"
--
-- Causa raíz:
-- En el sprint 23-may (commit que cerró deuda C4-F16), saldos_caja pasó
-- a ser cache derivado del ledger `movimientos` via trigger AFTER
-- INSERT/UPDATE/DELETE (`trg_sync_saldos_caja`). Cuando la RPC
-- eliminar_tenant_completo borra `movimientos`, el trigger se dispara y
-- reinserta filas en `saldos_caja`. Después cuando intenta borrar
-- `tenants`, falla por la FK saldos_caja → tenants.
--
-- También `trg_sync_pagos_rrhh` puede generar el mismo problema con
-- rrhh_pagos (cache derivado de movimientos del módulo RRHH).
--
-- Fix: deshabilitar AMBOS triggers durante el cleanup + re-habilitar al
-- final. Mismo patrón que ya hace con `trg_auditoria_no_update/delete` y
-- los triggers de `recetas_versiones`.
--
-- Impacto: la suite E2E full volverá a correr OK en CI. Sin esto, los 73
-- tests de e2e-full fallaban TODOS en su `beforeAll` con "crear-tenant
-- falló (409): SLUG_DUPLICATED" porque el tenant residual no se borraba.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.eliminar_tenant_completo(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_caller_tenant UUID;
  v_filas_borradas BIGINT := 0;
  v_rows INT;
  v_table_name TEXT;
  v_iteracion INT := 0;
  v_max_iteraciones INT := 20;
  v_borrado_esta_vuelta INT;
  v_tablas_pendientes TEXT[];
  v_tablas_proxima_vuelta TEXT[];
  v_fk_record RECORD;
  v_trig_name TEXT;
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND';
  END IF;
  SELECT tenant_id INTO v_caller_tenant FROM usuarios WHERE auth_id = v_caller_uid;
  IF v_caller_tenant IS NOT NULL AND v_caller_tenant = p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_ES_DEL_CALLER';
  END IF;

  -- Disable triggers append-only auditoria
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  -- FIX 2026-05-24: deshabilitar triggers cache del ledger movimientos.
  -- Sin esto, AFTER DELETE en movimientos dispara fn_trg_sync_saldos_caja
  -- que reinserta filas en saldos_caja → la posterior DELETE FROM tenants
  -- falla con FK violation. Mismo problema con trg_sync_pagos_rrhh.
  ALTER TABLE movimientos DISABLE TRIGGER trg_sync_saldos_caja;
  ALTER TABLE movimientos DISABLE TRIGGER trg_sync_pagos_rrhh;

  -- Disable all user triggers on recetas_versiones (append-only historial CMV)
  FOR v_trig_name IN
    SELECT t.tgname FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'recetas_versiones' AND NOT t.tgisinternal
  LOOP
    EXECUTE format('ALTER TABLE recetas_versiones DISABLE TRIGGER %I', v_trig_name);
  END LOOP;

  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- NULL-ear FKs nullable inter-tablas
  FOR v_fk_record IN
    SELECT DISTINCT conrelid::regclass::text AS from_table, att.attname AS from_col
    FROM pg_constraint pc
    JOIN unnest(pc.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute att ON att.attrelid = pc.conrelid AND att.attnum = k.attnum
    WHERE pc.contype = 'f' AND NOT att.attnotnull
      AND pc.confrelid::regclass::text IN (
        SELECT c.table_name FROM information_schema.columns c
        WHERE c.column_name = 'tenant_id' AND c.table_schema = 'public'
      )
      AND pc.conrelid::regclass::text IN (
        SELECT c.table_name FROM information_schema.columns c
        WHERE c.column_name = 'tenant_id' AND c.table_schema = 'public'
      )
      AND pc.conrelid::regclass::text NOT IN ('tenants', 'auditoria')
  LOOP
    BEGIN
      EXECUTE format('UPDATE %I SET %I = NULL WHERE tenant_id = $1 AND %I IS NOT NULL',
                     v_fk_record.from_table, v_fk_record.from_col, v_fk_record.from_col)
        USING p_tenant_id;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  SELECT array_agg(c.table_name) INTO v_tablas_pendientes
  FROM information_schema.columns c
  JOIN information_schema.tables t ON c.table_schema = t.table_schema AND c.table_name = t.table_name
  WHERE c.column_name = 'tenant_id' AND c.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND c.table_name NOT IN ('tenants', 'auditoria');

  WHILE array_length(v_tablas_pendientes, 1) > 0 AND v_iteracion < v_max_iteraciones LOOP
    v_iteracion := v_iteracion + 1;
    v_borrado_esta_vuelta := 0;
    v_tablas_proxima_vuelta := ARRAY[]::TEXT[];
    FOREACH v_table_name IN ARRAY v_tablas_pendientes LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name) USING p_tenant_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_filas_borradas := v_filas_borradas + v_rows;
        v_borrado_esta_vuelta := v_borrado_esta_vuelta + 1;
      EXCEPTION WHEN foreign_key_violation THEN
        v_tablas_proxima_vuelta := array_append(v_tablas_proxima_vuelta, v_table_name);
      WHEN OTHERS THEN
        RAISE WARNING 'DELETE en % falló: %', v_table_name, SQLERRM;
      END;
    END LOOP;
    IF v_borrado_esta_vuelta = 0 AND array_length(v_tablas_proxima_vuelta, 1) > 0 THEN
      RAISE EXCEPTION 'Stale tables tras vuelta %: %', v_iteracion, v_tablas_proxima_vuelta;
    END IF;
    v_tablas_pendientes := v_tablas_proxima_vuelta;
  END LOOP;

  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- Re-enable triggers
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;
  ALTER TABLE movimientos ENABLE TRIGGER trg_sync_saldos_caja;
  ALTER TABLE movimientos ENABLE TRIGGER trg_sync_pagos_rrhh;
  FOR v_trig_name IN
    SELECT t.tgname FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'recetas_versiones' AND NOT t.tgisinternal
  LOOP
    EXECUTE format('ALTER TABLE recetas_versiones ENABLE TRIGGER %I', v_trig_name);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'tenant_id', p_tenant_id,
    'filas_borradas', v_filas_borradas, 'iteraciones', v_iteracion);
END;
$$;

COMMENT ON FUNCTION public.eliminar_tenant_completo IS
  'Elimina tenant completo + todas las tablas con tenant_id. Fix 2026-05-24: '
  'disable trg_sync_saldos_caja + trg_sync_pagos_rrhh durante el cleanup '
  'para evitar que reinserten filas en saldos_caja/rrhh_pagos cuando se '
  'borran movimientos (cache derivado del ledger).';
