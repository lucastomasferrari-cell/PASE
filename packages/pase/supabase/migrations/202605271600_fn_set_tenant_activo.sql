-- =============================================================================
-- F6B: fn_set_tenant_activo con audit log
-- =============================================================================
-- Antes: admin-console hacía UPDATE tenants SET activo=... directo (sin audit
-- ni validación de quién lo cambió). Ahora pasa por RPC SECURITY DEFINER
-- que valida superadmin + escribe en auditoria.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_set_tenant_activo(
  p_tenant_id uuid,
  p_activo boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_nombre text;
  v_prev_activo boolean;
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin';
  END IF;

  SELECT nombre, activo INTO v_tenant_nombre, v_prev_activo
    FROM tenants WHERE id = p_tenant_id;
  IF v_tenant_nombre IS NULL THEN
    RAISE EXCEPTION 'TENANT_NO_ENCONTRADO';
  END IF;

  IF v_prev_activo = p_activo THEN
    RETURN jsonb_build_object('tenant_id', p_tenant_id, 'activo', p_activo, 'sin_cambio', true);
  END IF;

  UPDATE tenants SET activo = p_activo, updated_at = NOW() WHERE id = p_tenant_id;

  -- Audit log
  INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
  VALUES (
    'tenants',
    CASE WHEN p_activo THEN 'TENANT_ACTIVAR' ELSE 'TENANT_DESACTIVAR' END,
    jsonb_build_object(
      'tenant_id', p_tenant_id,
      'tenant_nombre', v_tenant_nombre,
      'previo_activo', v_prev_activo,
      'nuevo_activo', p_activo,
      'usuario_id', auth_usuario_id()
    )::text,
    NOW(),
    p_tenant_id
  );

  RETURN jsonb_build_object(
    'tenant_id', p_tenant_id,
    'tenant_nombre', v_tenant_nombre,
    'activo', p_activo,
    'previo_activo', v_prev_activo
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_set_tenant_activo(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_set_tenant_activo(uuid, boolean) TO authenticated, service_role;

DO $smoke$
DECLARE v_n int;
BEGIN
  SELECT COUNT(*) INTO v_n FROM pg_proc WHERE proname='fn_set_tenant_activo';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE FAIL: fn_set_tenant_activo no creada'; END IF;
  RAISE NOTICE 'SMOKE OK: fn_set_tenant_activo creada';
END $smoke$;

COMMIT;
