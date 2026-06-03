-- 202606031500_aplicar_saldo_a_favor.sql
-- Paso 2 del modelo Lucas/Agos 03-jun: usar el saldo a favor como
-- crédito al pagar otra factura del mismo proveedor.
--
-- NO mueve plata (no genera movimiento en saldos_caja). Solo:
--   1. Inserta una fila tipo='en_contra' en proveedor_saldo_movimientos
--      (= consume el crédito → el cache del proveedor baja).
--   2. Agrega una línea tipo='saldo_a_favor' al facturas.pagos JSON
--      para que el saldo_pendiente de la factura baje y el estado se
--      recalcule.
--
-- Patrón análogo a aplicar_nc_a_factura: el "pago" no es plata sino
-- un crédito que ya estaba registrado a favor del cliente.

CREATE OR REPLACE FUNCTION aplicar_saldo_a_favor_proveedor(
  p_factura_id TEXT,
  p_monto NUMERIC,
  p_fecha DATE DEFAULT CURRENT_DATE,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fac RECORD;
  v_tenant UUID;
  v_saldo_disponible NUMERIC;
  v_nuevos_pagos JSONB;
  v_total_pagado NUMERIC;
  v_nuevo_estado TEXT;
  v_saldo_pendiente NUMERIC;
  v_psm_id BIGINT;
  v_existing_psm RECORD;
BEGIN
  -- Idempotencia: si ya aplicamos este crédito (mismo key), retornar OK.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_psm
      FROM proveedor_saldo_movimientos
     WHERE motivo LIKE '%idemp:' || p_idempotency_key || '%'
       AND deleted_at IS NULL
     LIMIT 1;
    IF v_existing_psm.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'saldo_movimiento_id', v_existing_psm.id,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO';
  END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;
  IF v_fac.prov_id IS NULL THEN RAISE EXCEPTION 'FACTURA_SIN_PROVEEDOR'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  -- Saldo a favor disponible del proveedor (lock para evitar carrera).
  SELECT saldo_a_favor INTO v_saldo_disponible
    FROM proveedores WHERE id = v_fac.prov_id FOR UPDATE;
  IF v_saldo_disponible IS NULL OR v_saldo_disponible < p_monto THEN
    RAISE EXCEPTION 'SALDO_INSUFICIENTE';
  END IF;

  -- Saldo pendiente de la factura: no aplicar más de lo que falta pagar.
  v_saldo_pendiente := v_fac.total - COALESCE((
    SELECT SUM((e->>'monto')::numeric) FROM jsonb_array_elements(COALESCE(v_fac.pagos, '[]'::jsonb)) e
  ), 0);
  IF p_monto > v_saldo_pendiente THEN
    RAISE EXCEPTION 'MONTO_EXCEDE_SALDO_FACTURA';
  END IF;

  -- 1) Agregar línea tipo 'saldo_a_favor' al pagos JSON.
  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'tipo', 'saldo_a_favor',
      'monto', p_monto,
      'fecha', p_fecha
    )
  );
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;
  v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos
    WHERE id = p_factura_id;

  -- 2) Insertar fila 'en_contra' en el ledger (consume el crédito).
  --    El trigger recalcula proveedores.saldo_a_favor automáticamente.
  INSERT INTO proveedor_saldo_movimientos (
    tenant_id, proveedor_id, fecha, tipo, monto, motivo, factura_id, created_by
  ) VALUES (
    v_tenant, v_fac.prov_id, p_fecha, 'en_contra', p_monto,
    'Aplicado a factura ' || COALESCE(v_fac.nro, v_fac.id)
      || CASE WHEN p_idempotency_key IS NOT NULL THEN ' [idemp:' || p_idempotency_key || ']' ELSE '' END,
    p_factura_id, auth_usuario_id()
  ) RETURNING id INTO v_psm_id;

  PERFORM _auditar('facturas', 'APLICAR_SALDO_A_FAVOR', jsonb_build_object(
    'factura_id', p_factura_id,
    'proveedor_id', v_fac.prov_id,
    'monto', p_monto,
    'nuevo_estado', v_nuevo_estado,
    'saldo_movimiento_id', v_psm_id,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object(
    'saldo_movimiento_id', v_psm_id,
    'nuevo_estado', v_nuevo_estado,
    'total_pagado', v_total_pagado,
    'saldo_a_favor_restante', v_saldo_disponible - p_monto
  );
END;
$$;

REVOKE ALL ON FUNCTION aplicar_saldo_a_favor_proveedor(TEXT, NUMERIC, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aplicar_saldo_a_favor_proveedor(TEXT, NUMERIC, DATE, TEXT) TO authenticated;

COMMENT ON FUNCTION aplicar_saldo_a_favor_proveedor(TEXT, NUMERIC, DATE, TEXT) IS
  'Aplica saldo a favor del proveedor como crédito sobre una factura. ' ||
  'NO genera movimiento de caja (no es plata). Inserta línea tipo=saldo_a_favor ' ||
  'en facturas.pagos + fila tipo=en_contra en proveedor_saldo_movimientos.';

NOTIFY pgrst, 'reload schema';
