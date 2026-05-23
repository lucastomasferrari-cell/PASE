-- ═══════════════════════════════════════════════════════════════════════════
-- eliminar_tenant_completo: versión robusta que NULLea TODOS los FKs
--
-- En vez de mantener una lista de NULLeos específicos, hace un dump general:
-- antes del loop principal, para cada columna FK nullable que referencia
-- una tabla del tenant, hacer UPDATE SET = NULL. Después borrar.
--
-- Esto resuelve FK circulares irresolubles automáticamente — el costo es
-- una vuelta extra de UPDATEs al principio.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION eliminar_tenant_completo(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_caller_tenant uuid;
  v_filas_borradas bigint := 0;
  v_rows int;
  v_table_name text;
  v_col_name text;
  v_iteracion int := 0;
  v_max_iteraciones int := 20;
  v_borrado_esta_vuelta int;
  v_tablas_pendientes text[];
  v_tablas_proxima_vuelta text[];
  v_fk_record RECORD;
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin puede ejecutar eliminar_tenant_completo';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND: tenant % no existe', p_tenant_id;
  END IF;

  SELECT tenant_id INTO v_caller_tenant FROM usuarios WHERE auth_id = v_caller_uid;
  IF v_caller_tenant IS NOT NULL AND v_caller_tenant = p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_ES_DEL_CALLER';
  END IF;

  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── FASE DE PREPARACIÓN: NULL-ear TODOS los FK nullable inter-tablas ─
  -- Para cada constraint FK donde la columna del lado from es NULLABLE,
  -- y AMBAS tablas tienen tenant_id, hacer UPDATE SET NULL en el lado from.
  -- Esto resuelve cualquier FK circular automáticamente.
  FOR v_fk_record IN
    SELECT DISTINCT
      conrelid::regclass::text AS from_table,
      att.attname AS from_col
    FROM pg_constraint pc
    JOIN unnest(pc.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute att ON att.attrelid = pc.conrelid AND att.attnum = k.attnum
    WHERE pc.contype = 'f'
      AND NOT att.attnotnull -- solo NULLable
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
    EXCEPTION WHEN OTHERS THEN
      -- Si falla (ej. trigger lo bloquea), seguimos — el loop principal
      -- lo intentará igual.
      RAISE WARNING 'UPDATE NULL en %.% falló: %', v_fk_record.from_table, v_fk_record.from_col, SQLERRM;
    END;
  END LOOP;

  -- ─── Descubrir tablas con tenant_id ──────────────────────────────────
  SELECT array_agg(c.table_name) INTO v_tablas_pendientes
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON c.table_schema = t.table_schema AND c.table_name = t.table_name
  WHERE c.column_name = 'tenant_id'
    AND c.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND c.table_name NOT IN ('tenants', 'auditoria');

  -- ─── Iterar resolviendo FKs ──────────────────────────────────────────
  WHILE array_length(v_tablas_pendientes, 1) > 0 AND v_iteracion < v_max_iteraciones LOOP
    v_iteracion := v_iteracion + 1;
    v_borrado_esta_vuelta := 0;
    v_tablas_proxima_vuelta := ARRAY[]::text[];

    FOREACH v_table_name IN ARRAY v_tablas_pendientes LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name)
          USING p_tenant_id;
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
      RAISE EXCEPTION 'Stale tables tras vuelta %: % (FKs no resueltas)',
        v_iteracion, v_tablas_proxima_vuelta;
    END IF;

    v_tablas_pendientes := v_tablas_proxima_vuelta;
  END LOOP;

  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'filas_borradas', v_filas_borradas,
    'iteraciones', v_iteracion
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
