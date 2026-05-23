-- ═══════════════════════════════════════════════════════════════════════════
-- eliminar_tenant_completo: versión DINÁMICA que descubre tablas
--
-- La versión hardcoded (v2 en 202605222900) tenía que actualizarse cada vez
-- que se agregaba una tabla con tenant_id. Con 96+ tablas en prod al 22-may,
-- se volvió intratable mantener la lista a mano.
--
-- Esta versión:
--   1. Descubre todas las tablas (no vistas) con columna tenant_id.
--   2. Itera hasta 10 vueltas tratando de DELETE en cada una.
--   3. Si un DELETE falla por FK violation, ignora y reintenta en la siguiente
--      vuelta (otra tabla resolverá la FK al borrar sus filas).
--   4. Cuando una vuelta completa no logra borrar nada nuevo, sale.
--   5. Borra la fila del tenant.
--
-- Trade-off: más lento que la versión hardcoded en el peor caso (varias
-- pasadas) pero a prueba de futuro — agregás tabla nueva con tenant_id,
-- automáticamente la limpia.
--
-- Mantiene los mismos contracts: superadmin only, bloquea auto-borrado del
-- caller, devuelve filas_borradas. La signature es compatible.
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
  -- ─── 1. Validar permisos ─────────────────────────────────────────────────
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin puede ejecutar eliminar_tenant_completo';
  END IF;

  -- ─── 2. Validar tenant existe ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND: tenant % no existe', p_tenant_id;
  END IF;

  -- ─── 3. Bloqueo anti pie-en-el-tornillo ──────────────────────────────────
  SELECT tenant_id INTO v_caller_tenant FROM usuarios WHERE auth_id = v_caller_uid;
  IF v_caller_tenant IS NOT NULL AND v_caller_tenant = p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_ES_DEL_CALLER: no podés borrar el tenant en el que estás autenticado';
  END IF;

  -- ─── 4. Desactivar triggers append-only de auditoria ─────────────────────
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  -- ─── 5. Borrar auditoria del tenant primero ──────────────────────────────
  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── 6. Descubrir TODAS las tablas (no vistas) con tenant_id ─────────────
  -- Excluye 'tenants' (la borramos al final) y 'auditoria' (ya borrada arriba).
  SELECT array_agg(c.table_name) INTO v_tablas_pendientes
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON c.table_schema = t.table_schema AND c.table_name = t.table_name
  WHERE c.column_name = 'tenant_id'
    AND c.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'  -- excluye vistas
    AND c.table_name NOT IN ('tenants', 'auditoria');

  -- ─── 7. Iterar hasta 15 vueltas resolviendo FK violations ────────────────
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
        -- Hay otra tabla que aún referencia ésta — reintentar próxima vuelta.
        v_tablas_proxima_vuelta := array_append(v_tablas_proxima_vuelta, v_table_name);
      WHEN OTHERS THEN
        -- Otro error: lo loggeamos pero no abortamos. Si es real, va a
        -- fallar el DELETE FROM tenants al final.
        RAISE WARNING 'DELETE en % falló: % (%, sigo igual)',
          v_table_name, SQLERRM, SQLSTATE;
      END;
    END LOOP;

    -- Si esta vuelta no logró borrar NADA nuevo, las tablas que quedan
    -- tienen FKs irresolubles → abortar (mejor un error claro que loop infinito).
    IF v_borrado_esta_vuelta = 0 AND array_length(v_tablas_proxima_vuelta, 1) > 0 THEN
      RAISE EXCEPTION 'Stale tables tras vuelta %: % (FKs no resueltas)',
        v_iteracion, v_tablas_proxima_vuelta;
    END IF;

    v_tablas_pendientes := v_tablas_proxima_vuelta;
  END LOOP;

  -- ─── 8. Borrar tenant ────────────────────────────────────────────────────
  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── 9. Reactivar triggers ───────────────────────────────────────────────
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
