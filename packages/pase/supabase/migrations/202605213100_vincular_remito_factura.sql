-- ═══════════════════════════════════════════════════════════════════════════
-- BUG #4: pagar remito → vincular factura → factura quedaba pendiente
--
-- Reportado por Lucas 21-may 8pm: el operador a veces paga el remito ANTES
-- de tener la factura cargada (caso común: remito llega, se paga, factura
-- llega días después). Cuando se carga la factura y se vincula con el
-- remito, la factura debería quedar como PAGADA (el dinero ya salió).
--
-- Hoy: vincularRemitoAFactura() solo hace UPDATE remitos SET factura_id=X.
-- La factura sigue 'pendiente' y aparece como deuda activa.
--
-- Fix: RPC atómica vincular_remito_factura que:
-- 1. Lock ambos (remito + factura) con FOR UPDATE
-- 2. Valida consistencia (mismo proveedor, mismo tenant)
-- 3. Si el remito ya tenía pago (estado='pagado'), propaga el pago a la
--    factura: append en facturas.pagos[] + recalcula estado, actualiza
--    movimientos.fact_id para asociar el movimiento a la factura también
-- 4. Actualiza remito: estado='vinculado', factura_id=X
-- 5. Auditoría
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION vincular_remito_factura(
  p_remito_id TEXT,
  p_factura_id TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remito RECORD;
  v_factura RECORD;
  v_mov RECORD;
  v_nuevos_pagos jsonb;
  v_total_pagado numeric;
  v_nuevo_estado text;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'vincular_remito_factura' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay', true); END IF;
  END IF;

  IF p_remito_id IS NULL OR p_factura_id IS NULL THEN
    RAISE EXCEPTION 'PARAMETROS_INVALIDOS';
  END IF;

  -- Lock atómico del remito y la factura para evitar races.
  SELECT * INTO v_remito FROM remitos WHERE id = p_remito_id FOR UPDATE;
  IF v_remito IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_remito.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_ANULADO'; END IF;
  IF v_remito.factura_id IS NOT NULL THEN
    RAISE EXCEPTION 'REMITO_YA_VINCULADO: el remito ya está vinculado a otra factura';
  END IF;

  SELECT * INTO v_factura FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_factura IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_factura.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;

  -- Validar consistencia
  PERFORM _validar_local_autorizado(v_remito.local_id);
  PERFORM _validar_local_autorizado(v_factura.local_id);
  IF v_remito.tenant_id IS DISTINCT FROM v_factura.tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;
  IF v_remito.prov_id IS DISTINCT FROM v_factura.prov_id THEN
    RAISE EXCEPTION 'PROVEEDOR_DISTINTO: el remito es del prov % y la factura del prov %',
      v_remito.prov_id, v_factura.prov_id;
  END IF;

  -- Si el remito ya estaba pagado, propagar el pago a la factura.
  IF v_remito.estado = 'pagado' THEN
    -- Buscar el movimiento del pago del remito (debería haber 1 — pagar_remito
    -- inserta uno con tipo='Pago Proveedor' y remito_id_ref=remito.id).
    -- Lock también para evitar race con anular_remito concurrente.
    SELECT * INTO v_mov FROM movimientos
      WHERE remito_id_ref = p_remito_id
        AND tipo = 'Pago Proveedor'
        AND COALESCE(anulado, false) = false
      ORDER BY fecha DESC
      LIMIT 1
      FOR UPDATE;

    IF v_mov.id IS NOT NULL THEN
      -- Append el pago a facturas.pagos[]
      v_nuevos_pagos := COALESCE(v_factura.pagos, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'cuenta', v_mov.cuenta,
          'monto', ABS(v_mov.importe),
          'fecha', v_mov.fecha,
          'via_remito', p_remito_id
        )
      );

      SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
        FROM jsonb_array_elements(v_nuevos_pagos) e;

      v_nuevo_estado := CASE
        WHEN v_total_pagado >= v_factura.total THEN 'pagada'
        ELSE 'pendiente'
      END;

      UPDATE facturas
         SET estado = v_nuevo_estado,
             pagos = v_nuevos_pagos
       WHERE id = p_factura_id;

      -- Actualizar el movimiento para asociarlo también a la factura.
      -- El remito_id_ref se preserva (trazabilidad histórica).
      UPDATE movimientos
         SET fact_id = p_factura_id
       WHERE id = v_mov.id;
    END IF;
  END IF;

  -- Update remito al final
  UPDATE remitos
     SET factura_id = p_factura_id,
         estado = 'vinculado'
   WHERE id = p_remito_id;

  PERFORM _auditar('remitos', 'VINCULAR_FACTURA', jsonb_build_object(
    'remito_id', p_remito_id,
    'factura_id', p_factura_id,
    'remito_estado_previo', v_remito.estado,
    'factura_pagada_por_remito', (v_remito.estado = 'pagado' AND v_mov.id IS NOT NULL),
    'usuario_id', auth_usuario_id()
  ), v_factura.tenant_id);

  v_result := jsonb_build_object(
    'remito_id', p_remito_id,
    'factura_id', p_factura_id,
    'factura_estado', COALESCE(v_nuevo_estado, v_factura.estado),
    'pago_propagado', (v_remito.estado = 'pagado' AND v_mov.id IS NOT NULL)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('vincular_remito_factura', p_idempotency_key, v_factura.tenant_id, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION vincular_remito_factura(TEXT, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
