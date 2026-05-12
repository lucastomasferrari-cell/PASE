-- ═══════════════════════════════════════════════════════════════════════════
-- RPC cambiar_sueldo_empleado: registrar historial + actualizar atómico.
--
-- Cumple deuda C4 parcial. Antes (RRHHLegajo.tsx:239-244) eran 2 operaciones
-- separadas:
--   INSERT rrhh_historial_sueldos (...)
--   UPDATE rrhh_empleados SET sueldo_mensual = nuevo
-- Si el INSERT pasaba pero el UPDATE fallaba, el historial mostraba el
-- cambio pero el empleado seguía con el sueldo viejo en su legajo → todos
-- los cálculos de SAC, vacaciones, etc usaban el sueldo viejo.
--
-- Esta RPC hace ambas en TX única. SECURITY DEFINER + chequeo de permiso
-- 'rrhh' (encargados con permiso rrhh pueden cambiar sueldos; ajustar a
-- 'dueno/admin only' si Lucas lo pide).
--
-- Nota: la columna registrado_por es TEXT (no INTEGER FK) por legado del
-- schema rrhh_legajo. Se castea desde auth_usuario_id() para preservar
-- el comportamiento existente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cambiar_sueldo_empleado(
  p_emp_id        integer,
  p_nuevo_sueldo  numeric,
  p_motivo        text,
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
  -- ─── 1) Auth (regla C11) ─────────────────────────────────────────────────
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('rrhh')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso rrhh';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  -- ─── 2) Validar input ────────────────────────────────────────────────────
  IF p_emp_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  IF p_nuevo_sueldo IS NULL OR p_nuevo_sueldo <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO';
  END IF;

  -- ─── 3) Idempotency check ────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'cambiar_sueldo_empleado' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  -- ─── 4) Lock empleado + validaciones ─────────────────────────────────────
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_emp_id FOR UPDATE;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  IF v_emp.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;

  -- No-op si el sueldo no cambió.
  IF COALESCE(v_emp.sueldo_mensual, 0) = p_nuevo_sueldo THEN
    v_result := jsonb_build_object('ok', true, 'sin_cambio', true);
    RETURN v_result;
  END IF;

  -- ─── 5) INSERT historial + UPDATE empleado (atómico) ─────────────────────
  INSERT INTO rrhh_historial_sueldos (
    empleado_id, sueldo_anterior, sueldo_nuevo, motivo, registrado_por, tenant_id
  ) VALUES (
    p_emp_id, v_emp.sueldo_mensual, p_nuevo_sueldo, nullif(trim(p_motivo), ''),
    v_usuario_id::text,
    v_tenant
  );

  UPDATE rrhh_empleados
     SET sueldo_mensual = p_nuevo_sueldo
   WHERE id = p_emp_id;

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
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cambiar_sueldo_empleado(integer, numeric, text, text) TO authenticated;
REVOKE ALL ON FUNCTION cambiar_sueldo_empleado(integer, numeric, text, text) FROM PUBLIC;
