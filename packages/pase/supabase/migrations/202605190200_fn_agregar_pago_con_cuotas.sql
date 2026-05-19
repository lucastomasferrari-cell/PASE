-- ═══════════════════════════════════════════════════════════════════════════
-- fn_agregar_pago_venta_comanda — soporte cuotas en tarjeta crédito
-- Sesión 2026-05-18 (roadmap A4.2)
--
-- Agrega parámetro opcional p_cuotas que se persiste en la nueva columna
-- ventas_pos_pagos.cuotas (migration 202605190100). NULL = no aplica
-- (efectivo/débito/QR). 1 = "1 pago". 3/6/12 = típicos AR.
--
-- Lógica: solo se setea cuotas si el método es de crédito. Para los
-- demás métodos el valor llega NULL aunque venga del frontend.
--
-- DROPea la firma vieja (7 args) para que PostgREST solo resuelva a la
-- nueva. Sino quedan dos funciones conviviendo (como pasó con
-- anular_movimiento — bug detectado y fixeado el 18-may).
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS fn_agregar_pago_venta_comanda(BIGINT, TEXT, NUMERIC, TEXT, UUID, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION fn_agregar_pago_venta_comanda(
  p_venta_id BIGINT,
  p_metodo TEXT,
  p_monto NUMERIC,
  p_idempotency_key TEXT,
  p_cobrado_por UUID DEFAULT NULL,
  p_vuelto NUMERIC DEFAULT NULL,
  p_propina_incluida NUMERIC DEFAULT 0,
  p_cuotas INTEGER DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_pago_id BIGINT;
  v_total_pagado NUMERIC;
  v_local_id INTEGER;
  v_turno_id BIGINT;
  v_cuotas_efectivo INTEGER;
BEGIN
  SELECT id INTO v_pago_id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key;
  IF v_pago_id IS NOT NULL THEN RETURN v_pago_id; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta.estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_venta.estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_total_pagado
    FROM ventas_pos_pagos
   WHERE venta_id = p_venta_id AND estado = 'confirmado';

  IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN
    RAISE EXCEPTION 'SOBREPAGO: cobrarías % cuando faltan %',
      p_monto, GREATEST(0, v_venta.total - v_total_pagado);
  END IF;

  -- Cuotas solo aplican a métodos de crédito. Para los demás se ignora
  -- (NULL en DB). Reconocemos por nombre del método (los slugs típicos
  -- en metodos_cobro incluyen 'credito', 'tarjeta_credito', 'tc', etc.).
  v_cuotas_efectivo := CASE
    WHEN p_cuotas IS NULL THEN NULL
    WHEN lower(p_metodo) LIKE '%credit%' THEN p_cuotas
    WHEN lower(p_metodo) LIKE '%tc%' THEN p_cuotas
    ELSE NULL
  END;

  INSERT INTO ventas_pos_pagos (
    tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
    cobrado_por, vuelto, propina_incluida, cuotas, estado, confirmado_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, p_metodo, p_monto, p_idempotency_key,
    COALESCE(p_cobrado_por, v_venta.cajero_id), p_vuelto, COALESCE(p_propina_incluida, 0),
    v_cuotas_efectivo,
    'confirmado', NOW()
  ) RETURNING id INTO v_pago_id;

  IF v_total_pagado + p_monto >= v_venta.total - 0.01 THEN
    UPDATE ventas_pos SET
      estado = 'cobrada',
      cobrada_at = NOW(),
      updated_at = NOW()
    WHERE id = p_venta_id;

    IF v_venta.mesa_id IS NOT NULL THEN
      UPDATE mesas SET estado = 'libre' WHERE id = v_venta.mesa_id;
    END IF;
  END IF;

  v_local_id := v_venta.local_id;
  v_turno_id := v_venta.turno_caja_id;
  IF v_turno_id IS NOT NULL THEN
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id, tipo,
      monto, metodo, motivo, venta_id, idempotency_key
    ) VALUES (
      v_venta.tenant_id, v_local_id, v_turno_id,
      COALESCE(p_cobrado_por, (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
      'venta', p_monto, p_metodo,
      'Cobro venta #' || p_venta_id, p_venta_id,
      'mov_' || p_idempotency_key
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_pago_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_agregar_pago_venta_comanda(BIGINT, TEXT, NUMERIC, TEXT, UUID, NUMERIC, NUMERIC, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
