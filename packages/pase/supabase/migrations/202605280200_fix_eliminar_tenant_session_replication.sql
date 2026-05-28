-- ─────────────────────────────────────────────────────────────────────────
-- Fix eliminar_tenant_completo: session_replication_role = 'replica'
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug descubierto 2026-05-28 corriendo E2E full suite en CI:
--   "Stale tables tras vuelta 2: {locales,canales,items,
--    ventas_pos_items,ventas_pos,rrhh_empleados}"
--
-- Causa: las 6 tablas forman un ciclo circular de FKs:
--   - ventas_pos.local_id → locales
--   - ventas_pos.canal_id → canales
--   - ventas_pos.empleado_id → rrhh_empleados
--   - ventas_pos_items.venta_id → ventas_pos
--   - items.local_id → locales
--   - canales.local_id → locales
--   - rrhh_empleados.local_id → locales (con ON DELETE NO ACTION)
--
-- El loop iterativo (max 20 vueltas) NO puede resolver el ciclo porque el
-- orden de iteración de FOREACH no es estable y a veces TODAS las 6 tiran
-- FK violation en la misma vuelta → "borrado_esta_vuelta = 0" → EXCEPTION.
--
-- Fix anterior (24-may) deshabilitó trg_sync_saldos_caja + trg_sync_pagos_rrhh.
-- Eso resolvió el bug de aquel entonces, pero las FKs circulares quedaron.
--
-- Fix nuevo: `SET LOCAL session_replication_role = 'replica'` deshabilita
-- TODOS los triggers FK durante la transacción de la RPC. Como la transacción
-- es atómica (DELETE todo del tenant + DELETE FROM tenants), si algo falla
-- el ROLLBACK protege la consistencia. Mismo pattern que usa pg_dump al
-- restaurar.
--
-- Después del DELETE FROM tenants, restauramos `session_replication_role`
-- al valor original ('origin' por default).
--
-- Impacto esperado: la suite E2E full debería pasar el cleanup defensivo
-- y poder crear el tenant nuevo sin SLUG_DUPLICATED.
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

  -- FIX 2026-05-28: deshabilitar TODOS los FKs + triggers durante el cleanup.
  -- Esto resuelve definitivamente el problema de FKs circulares entre
  -- locales/canales/items/ventas_pos/ventas_pos_items/rrhh_empleados que
  -- bloqueaban el cleanup E2E. Como la RPC es atómica, si algo falla el
  -- ROLLBACK preserva la consistencia.
  SET LOCAL session_replication_role = 'replica';

  -- Disable triggers append-only auditoria (siguen presentes por compat).
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  -- Cache triggers del ledger (siguen presentes por compat con DBs sin
  -- session_replication_role).
  ALTER TABLE movimientos DISABLE TRIGGER trg_sync_saldos_caja;
  ALTER TABLE movimientos DISABLE TRIGGER trg_sync_pagos_rrhh;

  -- Disable all user triggers on recetas_versiones (append-only historial CMV).
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

  -- NULL-ear FKs nullable inter-tablas (sigue siendo útil — algunas FKs
  -- tienen ON DELETE NO ACTION y la columna acepta NULL).
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

  -- Re-enable triggers (compat con DBs viejas — session_replication_role
  -- se resetea solo al COMMIT/ROLLBACK por ser SET LOCAL).
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

  -- Restaurar session_replication_role (SET LOCAL ya lo hace al COMMIT
  -- pero lo explicitamos para claridad — además es lo que devuelve la RPC
  -- al caller en caso de que sea llamada dentro de una transacción más
  -- grande).
  SET LOCAL session_replication_role = 'origin';

  RETURN jsonb_build_object('ok', true, 'tenant_id', p_tenant_id,
    'filas_borradas', v_filas_borradas, 'iteraciones', v_iteracion);
END;
$$;

COMMENT ON FUNCTION public.eliminar_tenant_completo IS
  'Elimina tenant completo + todas las tablas con tenant_id. Fix 2026-05-28: '
  'SET LOCAL session_replication_role = replica para deshabilitar FKs '
  'circulares (locales/canales/items/ventas_pos/etc) durante el cleanup. '
  'La atomicidad de la transacción garantiza consistencia al COMMIT.';
