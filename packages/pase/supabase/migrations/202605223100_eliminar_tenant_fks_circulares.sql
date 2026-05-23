-- ═══════════════════════════════════════════════════════════════════════════
-- eliminar_tenant_completo: manejar FKs circulares conocidas
--
-- La RPC dinámica (202605223000) falla con "Stale tables tras vuelta 5"
-- cuando hay FK circular entre items y recetas:
--   - items.receta_id_vigente → recetas.id
--   - recetas.item_id → items.id
--
-- Esta versión hace una "fase de preparación" antes del loop principal
-- que NULL-ea los FKs que sabemos son circulares. Si aparecen otras FK
-- circulares, agregar acá.
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
  v_iteracion int := 0;
  v_max_iteraciones int := 15;
  v_borrado_esta_vuelta int;
  v_tablas_pendientes text[];
  v_tablas_proxima_vuelta text[];
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

  -- ─── FASE DE PREPARACIÓN: romper FK circulares conocidas ─────────────
  -- items.receta_id_vigente ↔ recetas.item_id es circular.
  -- NULL-eamos receta_id_vigente y receta_version_id_vigente para que
  -- después se pueda borrar recetas primero, después items.
  UPDATE items SET receta_id_vigente = NULL, receta_version_id_vigente = NULL
    WHERE tenant_id = p_tenant_id;

  -- Si aparecen más circulares en el futuro, agregar UPDATEs acá.

  -- ─── Descubrir todas las tablas con tenant_id ────────────────────────
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
        RAISE WARNING 'DELETE en % falló: % (%, sigo igual)',
          v_table_name, SQLERRM, SQLSTATE;
      END;
    END LOOP;

    IF v_borrado_esta_vuelta = 0 AND array_length(v_tablas_proxima_vuelta, 1) > 0 THEN
      RAISE EXCEPTION 'Stale tables tras vuelta %: % (FKs no resueltas — agregar UPDATE NULL en fase preparación si es circular)',
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
