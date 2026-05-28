-- ─────────────────────────────────────────────────────────────────────────
-- Fix eliminar_tenant_completo: DELETE en orden explícito para las
-- 6 tablas con FKs circulares (rollback parcial del fix anterior).
-- ─────────────────────────────────────────────────────────────────────────
--
-- El fix anterior (202605280200) usó `SET LOCAL session_replication_role
-- = 'replica'` pero falla en Supabase con:
--   "permission denied to set parameter 'session_replication_role'"
--
-- Porque session_replication_role requiere SUPERUSER y el owner de la
-- RPC (postgres en local) NO es superuser en Supabase managed.
--
-- ### Nuevo approach: DELETE explícito en orden topológico
--
-- Las 6 tablas circulares: locales, canales, items, rrhh_empleados,
-- ventas_pos, ventas_pos_items.
--
-- Análisis de dependencias (más hija → más padre):
--   1. ventas_pos_pagos    → ventas_pos
--   2. ventas_pos_overrides → ventas_pos + ventas_pos_items + items
--   3. ventas_pos_items    → ventas_pos + items
--   4. ventas_pos          → locales + canales + rrhh_empleados
--   5. items               → locales
--   6. canales             → locales
--   7. rrhh_empleado_locales → rrhh_empleados + locales
--   8. rrhh_empleados      → locales
--   9. locales             → (nada)
--
-- Borrando en ese orden, ninguna queda con FKs pendientes. Después el
-- loop iterativo de la RPC limpia el resto (las otras ~80 tablas con
-- tenant_id no tienen FKs circulares y se resuelven en 1-2 vueltas).
--
-- Fix anterior session_replication_role queda como NO-OP (eliminamos
-- la línea para que no rompa). El resto de los disable trigger del fix
-- 24-may quedan porque siguen siendo necesarios para los triggers
-- append-only y cache derivado.
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

  -- Disable cache triggers del ledger movimientos.
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

  -- ── PRE-FASE 1: NULL-ear FKs nullable inter-tablas. ──
  -- Mantenido del fix anterior — quita los nullable FK references al
  -- mismo tenant para reducir el grafo de FKs circulares.
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

  -- ── PRE-FASE 2: borrar las tablas con FKs circulares en orden topológico ──
  -- Esto preventiva-mente vacía el ciclo locales/canales/items/ventas_pos/etc.
  -- Cada DELETE va en su propio BEGIN/EXCEPTION por si una tabla ya está
  -- vacía (no rompe).
  --
  -- Orden: más hija primero, más padre al final.
  PERFORM 1; -- dummy para no romper si el bloque queda vacío

  -- Nivel 4 (más hijas — child de child de child):
  BEGIN EXECUTE 'DELETE FROM ventas_pos_pagos WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase ventas_pos_pagos: %', SQLERRM; END;

  BEGIN EXECUTE 'DELETE FROM ventas_pos_overrides WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase ventas_pos_overrides: %', SQLERRM; END;

  -- Nivel 3:
  BEGIN EXECUTE 'DELETE FROM ventas_pos_items WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase ventas_pos_items: %', SQLERRM; END;

  -- Nivel 2:
  BEGIN EXECUTE 'DELETE FROM ventas_pos WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase ventas_pos: %', SQLERRM; END;

  -- Nivel 1.5 — items hijo de locales:
  BEGIN EXECUTE 'DELETE FROM items WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase items: %', SQLERRM; END;

  BEGIN EXECUTE 'DELETE FROM canales WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase canales: %', SQLERRM; END;

  -- Nivel 1 — rrhh_empleados hijo de locales:
  BEGIN EXECUTE 'DELETE FROM rrhh_empleado_locales WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase rrhh_empleado_locales: %', SQLERRM; END;

  BEGIN EXECUTE 'DELETE FROM rrhh_empleados WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase rrhh_empleados: %', SQLERRM; END;

  -- Nivel 0 — locales padre de todo:
  BEGIN EXECUTE 'DELETE FROM locales WHERE tenant_id = $1' USING p_tenant_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_filas_borradas := v_filas_borradas + v_rows;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'pre-fase locales: %', SQLERRM; END;

  -- ── FASE 3: loop iterativo limpia el resto de las tablas con tenant_id ──
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
  'Elimina tenant completo + todas las tablas con tenant_id. Fix 2026-05-28: '
  'pre-fase de borrado explícito en orden topológico para las 6 tablas con '
  'FKs circulares (locales/canales/items/ventas_pos/etc.). Antes intentaba '
  'session_replication_role=replica pero falla en Supabase managed por permiso.';
