-- ════════════════════════════════════════════════════════════════════
-- Sprint anti-huérfanos (09-jun) — bypass del guard en eliminar_tenant_completo.
-- Agrega set_config('pase.skip_orphan_guard','on',true) al inicio para que el
-- borrado masivo del tenant (y el teardown de tests que lo usa) no choque con
-- el guard fn_guard_no_borrar_con_movimientos. Cuerpo idéntico al vigente + 1 línea.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.eliminar_tenant_completo(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- ★ Sprint anti-huérfanos (09-jun): bypass del guard fn_guard_no_borrar_con_movimientos
  -- durante el borrado masivo del tenant (la transacción borra todo en orden FK).
  PERFORM set_config('pase.skip_orphan_guard', 'on', true);

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

  -- ★ NUEVO FIX 29-may: disable trigger append-only de ventas_pos_overrides.
  -- Sin esto la tabla queda como cabeza de cadena que bloquea 6 tablas.
  ALTER TABLE ventas_pos_overrides DISABLE TRIGGER trg_overrides_no_modify;

  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ── PRE-FASE 1: NULL-ear FKs nullable inter-tablas. ──
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
  PERFORM 1;

  -- Nivel 4 (más hijas):
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

  -- ── FASE 3: loop iterativo limpia el resto ──
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
  ALTER TABLE ventas_pos_overrides ENABLE TRIGGER trg_overrides_no_modify;
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
$function$
;
