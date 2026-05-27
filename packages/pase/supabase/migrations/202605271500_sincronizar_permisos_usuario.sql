-- =============================================================================
-- F4A#4: RPC atómica sincronizar_permisos_usuario
-- =============================================================================
-- Bug histórico: Usuarios.tsx hace DELETE + INSERT + UPDATE en 4-5 tablas por
-- separado. Si el INSERT de permisos falla mid-batch (RLS, network, etc.),
-- el DELETE previo ya dejó al user con 0 permisos. El comentario en el
-- archivo lo admite ("Bug crítico fixeado 2026-05-14") pero la solución fue
-- parchear el reporte de error, no la atomicidad real.
--
-- Esta RPC consolida todo el flow en una transacción única:
--   - actualiza rol en usuarios
--   - reemplaza usuario_permisos del user
--   - reemplaza usuario_locales del user
--   - actualiza cuentas_visibles + cuentas_operables
--   - opcionalmente asigna rol_id RBAC
--   - actualiza también el campo viejo usuarios.locales (backward compat)
-- Si CUALQUIER paso falla, ROLLBACK automático y user queda como estaba.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sincronizar_permisos_usuario(
  p_usuario_id integer,
  p_rol text,                              -- 'dueno' o 'encargado'
  p_modulos text[],                        -- permisos por módulo
  p_locales integer[],                     -- locales asignados
  p_cuentas_visibles text[] DEFAULT NULL,  -- NULL = todas
  p_cuentas_operables text[] DEFAULT NULL, -- NULL = todas
  p_cuentas_all boolean DEFAULT true,      -- si true, ignora cuentas_*
  p_rol_id uuid DEFAULT NULL,              -- rol RBAC opcional
  p_activo boolean DEFAULT NULL            -- NULL = no tocar
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_tenant uuid;
  v_caller_tenant uuid;
  v_existing_rol text;
  v_visibles text[];
  v_operables text[];
  v_perm_inserted int := 0;
  v_loc_inserted int := 0;
BEGIN
  -- 1. Auth: caller debe ser dueno/admin del MISMO tenant del target user
  -- (o superadmin).
  v_caller_tenant := auth_tenant_id();
  IF v_caller_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_es_superadmin()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  -- 2. Validar target user existe + traer su tenant_id
  SELECT tenant_id, rol INTO v_target_tenant, v_existing_rol
    FROM usuarios WHERE id = p_usuario_id;
  IF v_target_tenant IS NULL AND v_existing_rol IS NULL THEN
    RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO';
  END IF;

  -- 3. Cross-tenant check: caller debe pertenecer al mismo tenant
  IF NOT auth_es_superadmin() AND v_target_tenant IS DISTINCT FROM v_caller_tenant THEN
    RAISE EXCEPTION 'USUARIO_CROSS_TENANT';
  END IF;

  -- 4. No degradar superadmin desde acá
  IF v_existing_rol = 'superadmin' AND p_rol IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'NO_PUEDE_DEGRADAR_SUPERADMIN';
  END IF;

  -- 5. Calcular cuentas (null si all)
  v_visibles := CASE WHEN p_cuentas_all THEN NULL ELSE p_cuentas_visibles END;
  v_operables := CASE WHEN p_cuentas_all THEN NULL ELSE p_cuentas_operables END;

  -- 6. Update usuario base (rol + locales backward-compat + cuentas + activo)
  UPDATE usuarios SET
    rol = p_rol,
    locales = p_locales,
    cuentas_visibles = v_visibles,
    cuentas_operables = v_operables,
    activo = COALESCE(p_activo, activo)
  WHERE id = p_usuario_id;

  -- 7. RBAC role
  IF p_rol_id IS NOT NULL THEN
    PERFORM asignar_rol_a_usuario(p_usuario_id, p_rol_id);
  END IF;

  -- 8. Permisos: replace
  DELETE FROM usuario_permisos WHERE usuario_id = p_usuario_id;
  IF p_rol <> 'dueno' AND p_modulos IS NOT NULL AND array_length(p_modulos, 1) > 0 THEN
    INSERT INTO usuario_permisos (usuario_id, modulo_slug, tenant_id)
    SELECT p_usuario_id, slug, v_target_tenant
      FROM unnest(p_modulos) AS slug;
    GET DIAGNOSTICS v_perm_inserted = ROW_COUNT;
  END IF;

  -- 9. Locales: replace
  DELETE FROM usuario_locales WHERE usuario_id = p_usuario_id;
  IF p_locales IS NOT NULL AND array_length(p_locales, 1) > 0 THEN
    INSERT INTO usuario_locales (usuario_id, local_id, tenant_id)
    SELECT p_usuario_id, lid, v_target_tenant
      FROM unnest(p_locales) AS lid;
    GET DIAGNOSTICS v_loc_inserted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'usuario_id', p_usuario_id,
    'rol', p_rol,
    'permisos_count', v_perm_inserted,
    'locales_count', v_loc_inserted,
    'cuentas_all', p_cuentas_all
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION sincronizar_permisos_usuario(integer, text, text[], integer[], text[], text[], boolean, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sincronizar_permisos_usuario(integer, text, text[], integer[], text[], text[], boolean, uuid, boolean) TO authenticated, service_role;

-- Smoke check
DO $smoke$
DECLARE v_n integer;
BEGIN
  SELECT COUNT(*) INTO v_n FROM pg_proc WHERE proname = 'sincronizar_permisos_usuario';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL: RPC no creada';
  END IF;
  RAISE NOTICE 'SMOKE OK: sincronizar_permisos_usuario creada';
END $smoke$;

COMMIT;
