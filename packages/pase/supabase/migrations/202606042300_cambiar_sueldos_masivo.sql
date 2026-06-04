-- 202606042300_cambiar_sueldos_masivo.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- RPC cambiar_sueldos_masivo: aplica varios cambios de sueldo en UNA
-- transacción (todo o nada). Pedido Lucas 04-jun (planilla de sueldos +
-- aumentos masivos por % o monto fijo, a todos o a los seleccionados).
--
-- Reusa exactamente la lógica de cambiar_sueldo_empleado (12-may) pero en lote:
-- por cada cambio inserta en rrhh_historial_sueldos + actualiza
-- rrhh_empleados.sueldo_mensual, con el mismo motivo para todos. Atómica:
-- si uno falla, no se aplica ninguno.
--
-- Auth (C11): dueno/admin o permiso 'rrhh' (igual que cambiar_sueldo_empleado).
-- Idempotency (C1): idempotency_keys (rpc_name, key, tenant_id).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cambiar_sueldos_masivo(
  p_cambios          jsonb,        -- [{ "emp_id": int, "nuevo_sueldo": numeric }, ...]
  p_motivo           text DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_cached jsonb;
  v_result jsonb;
  v_item jsonb;
  v_emp_id uuid;          -- rrhh_empleados.id es UUID (no integer)
  v_nuevo numeric;
  v_emp RECORD;
  v_cambiados integer := 0;
  v_total_ant numeric := 0;
  v_total_nue numeric := 0;
BEGIN
  -- ─── 1) Auth (C11) ───────────────────────────────────────────────────────
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('rrhh')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso rrhh';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  -- ─── 2) Validar input ────────────────────────────────────────────────────
  IF p_cambios IS NULL OR jsonb_typeof(p_cambios) <> 'array'
     OR jsonb_array_length(p_cambios) = 0 THEN
    RAISE EXCEPTION 'SIN_CAMBIOS';
  END IF;

  -- ─── 3) Idempotency check ────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'cambiar_sueldos_masivo' AND key = p_idempotency_key
        AND tenant_id = v_tenant;
    IF v_cached IS NOT NULL THEN
      RETURN v_cached || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  -- ─── 4) Loop atómico: historial + update por cada empleado ───────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_cambios) LOOP
    v_emp_id := (v_item->>'emp_id')::uuid;
    v_nuevo  := (v_item->>'nuevo_sueldo')::numeric;
    IF v_emp_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
    IF v_nuevo IS NULL OR v_nuevo <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

    SELECT * INTO v_emp FROM rrhh_empleados WHERE id = v_emp_id FOR UPDATE;
    IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
    IF v_emp.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;

    -- No-op si el sueldo no cambió (no ensucia el historial).
    IF COALESCE(v_emp.sueldo_mensual, 0) = v_nuevo THEN CONTINUE; END IF;

    INSERT INTO rrhh_historial_sueldos (
      empleado_id, sueldo_anterior, sueldo_nuevo, motivo, registrado_por, tenant_id
    ) VALUES (
      v_emp_id, v_emp.sueldo_mensual, v_nuevo,
      nullif(trim(coalesce(p_motivo, '')), ''),
      v_usuario_id, v_tenant   -- registrado_por es integer (usuario_id)
    );

    UPDATE rrhh_empleados SET sueldo_mensual = v_nuevo WHERE id = v_emp_id;

    v_cambiados := v_cambiados + 1;
    v_total_ant := v_total_ant + COALESCE(v_emp.sueldo_mensual, 0);
    v_total_nue := v_total_nue + v_nuevo;
  END LOOP;

  v_result := jsonb_build_object(
    'ok', true,
    'cambiados', v_cambiados,
    'total_anterior', v_total_ant,
    'total_nuevo', v_total_nue,
    'registrado_por_uid', v_caller_uid
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('cambiar_sueldos_masivo', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cambiar_sueldos_masivo(jsonb, text, text) TO authenticated;
REVOKE ALL ON FUNCTION cambiar_sueldos_masivo(jsonb, text, text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
