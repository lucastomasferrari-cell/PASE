-- 202606021400_asignar_mesa_reserva.sql
-- Brainstorm #8 Fase 5 Chunk D — Asignar mesa a reserva.
--
-- La columna reservas.mesa_id ya existe desde 202605203600. Lo que faltaba
-- era una RPC dedicada para que el admin asigne una mesa a la reserva
-- cuando el cliente llega (check-in). Hoy había que UPDATE directo, que
-- viola C4 (no direct write a tablas financieras... no, reservas no es
-- financiera, pero la asignación de mesa debería pasar por RPC para que
-- queden auditadas + se valide que la mesa pertenece al local).

CREATE OR REPLACE FUNCTION fn_asignar_mesa_reserva(
  p_reserva_id BIGINT,
  p_mesa_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_actual UUID := auth_tenant_id();
  v_local_reserva INTEGER;
  v_local_mesa INTEGER;
  v_tenant_reserva UUID;
  v_estado TEXT;
BEGIN
  -- Validar reserva existe + mismo tenant
  SELECT local_id, tenant_id, estado
    INTO v_local_reserva, v_tenant_reserva, v_estado
    FROM reservas WHERE id = p_reserva_id;

  IF v_local_reserva IS NULL THEN
    RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA';
  END IF;
  IF v_tenant_reserva != v_tenant_actual THEN
    RAISE EXCEPTION 'RESERVA_OTRO_TENANT';
  END IF;
  IF v_estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ASIGNABLE: estado=% (solo pendiente o confirmada)', v_estado;
  END IF;

  -- Validar mesa existe + mismo local que la reserva
  SELECT local_id INTO v_local_mesa
    FROM mesas WHERE id = p_mesa_id;

  IF v_local_mesa IS NULL THEN
    RAISE EXCEPTION 'MESA_NO_ENCONTRADA';
  END IF;
  IF v_local_mesa != v_local_reserva THEN
    RAISE EXCEPTION 'MESA_OTRO_LOCAL: mesa=local % vs reserva=local %',
      v_local_mesa, v_local_reserva;
  END IF;

  -- Asignar
  UPDATE reservas SET
    mesa_id = p_mesa_id,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_asignar_mesa_reserva(BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_asignar_mesa_reserva(BIGINT, BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION fn_asignar_mesa_reserva IS
  'Asigna una mesa a una reserva pendiente/confirmada. Valida tenant + local. F5 Chunk D.';
