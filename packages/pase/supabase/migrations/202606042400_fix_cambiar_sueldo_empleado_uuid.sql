-- 202606042400_fix_cambiar_sueldo_empleado_uuid.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- BUG: cambiar_sueldo_empleado declaraba p_emp_id INTEGER, pero
-- rrhh_empleados.id es UUID. El Legajo (RRHHLegajo.tsx) la llama con
-- p_emp_id = emp.id (uuid) → PostgREST no puede castear el uuid a integer y
-- el cambio de sueldo de UN empleado desde el legajo fallaba.
-- (Detectado 04-jun al construir la versión masiva cambiar_sueldos_masivo.)
--
-- Fix: DROP de la versión integer + CREATE con p_emp_id UUID. El cuerpo es
-- idéntico al vivo — ya usaba p_emp_id para el lookup/insert, que ahora
-- matchea (uuid = uuid). registrado_por es integer (usuario_id).
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS cambiar_sueldo_empleado(integer, numeric, text, text);

CREATE OR REPLACE FUNCTION cambiar_sueldo_empleado(
  p_emp_id          uuid,
  p_nuevo_sueldo    numeric,
  p_motivo          text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_emp RECORD;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('rrhh')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso rrhh';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_emp_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  IF p_nuevo_sueldo IS NULL OR p_nuevo_sueldo <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO';
  END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'cambiar_sueldo_empleado' AND key = p_idempotency_key
        AND tenant_id = v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_emp_id FOR UPDATE;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  IF v_emp.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;

  IF COALESCE(v_emp.sueldo_mensual, 0) = p_nuevo_sueldo THEN
    RETURN jsonb_build_object('ok', true, 'sin_cambio', true);
  END IF;

  INSERT INTO rrhh_historial_sueldos (
    empleado_id, sueldo_anterior, sueldo_nuevo, motivo, registrado_por, tenant_id
  ) VALUES (
    p_emp_id, v_emp.sueldo_mensual, p_nuevo_sueldo, nullif(trim(p_motivo), ''),
    v_usuario_id,
    v_tenant
  );

  UPDATE rrhh_empleados SET sueldo_mensual = p_nuevo_sueldo WHERE id = p_emp_id;

  v_result := jsonb_build_object(
    'ok', true,
    'emp_id', p_emp_id,
    'sueldo_anterior', v_emp.sueldo_mensual,
    'sueldo_nuevo', p_nuevo_sueldo,
    'registrado_por_uid', v_caller_uid
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('cambiar_sueldo_empleado', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cambiar_sueldo_empleado(uuid, numeric, text, text) TO authenticated;
REVOKE ALL ON FUNCTION cambiar_sueldo_empleado(uuid, numeric, text, text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
