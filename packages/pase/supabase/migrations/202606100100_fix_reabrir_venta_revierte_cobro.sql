-- ════════════════════════════════════════════════════════════════════════
-- COMANDA — fn_reabrir_venta_comanda: reabrir una venta cobrada tiene que
-- DESHACER el cobro (09-jun, endurecimiento pre-piloto).
--
-- BUG (confirmado por mutante mesa_ops): reabrir solo cambiaba estado y
-- cobrada_at, dejando vivos los pagos (ventas_pos_pagos) y los movimientos
-- de caja del cobro original. Como fn_cobrar_venta_comanda exige que los
-- pagos sumen el TOTAL completo y siempre inserta pagos + movimientos
-- nuevos, el ciclo cobrar→reabrir→re-cobrar dejaba 2× el total en la caja
-- del turno → arqueo descuadrado y "faltante" fantasma acusando al cajero.
--
-- FIX (mismo patrón que fn_trg_revertir_movimientos_al_anular_venta):
--   1. Por cada pago confirmado: movimiento compensatorio 'venta_anulada'
--      con monto negativo (o cola en reversos_pendientes si no hay turno
--      abierto), idempotente por clave 'reverso_reopen_<venta>_<pago>'.
--   2. Los pagos del cobro original pasan a estado='reembolsado' +
--      deleted_at (dejan de contar en reportes y en el próximo cobro).
--   3. Si la venta tenía mesa, la mesa vuelve a 'ocupada' (la venta está
--      activa de nuevo; antes quedaba 'libre' con una venta viva encima).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_reabrir_venta_comanda(p_venta_id bigint, p_manager_id uuid, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_turno_id BIGINT;
  v_pago RECORD;
  v_empleado UUID;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id AND estado = 'cobrada';
  IF v_venta.id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_REOPEN'; END IF;

  -- IDOR: la venta debe ser de un local autorizado para el caller.
  PERFORM fn_assert_local_autorizado(v_venta.local_id);

  SELECT id INTO v_turno_id
    FROM turnos_caja
   WHERE local_id = v_venta.local_id AND estado = 'abierto'
   LIMIT 1;

  v_empleado := v_venta.cajero_id;
  IF v_empleado IS NULL AND v_turno_id IS NOT NULL THEN
    SELECT cajero_id INTO v_empleado FROM turnos_caja WHERE id = v_turno_id;
  END IF;

  -- 1+2. Revertir cada pago confirmado del cobro original.
  FOR v_pago IN
    SELECT id, metodo, monto, cobrado_por
      FROM ventas_pos_pagos
     WHERE venta_id = p_venta_id
       AND estado = 'confirmado'
       AND deleted_at IS NULL
  LOOP
    IF v_turno_id IS NOT NULL THEN
      INSERT INTO movimientos_caja (
        tenant_id, local_id, turno_caja_id, empleado_id,
        tipo, monto, metodo, motivo, venta_id, idempotency_key
      ) VALUES (
        v_venta.tenant_id, v_venta.local_id, v_turno_id,
        COALESCE(v_pago.cobrado_por, v_empleado),
        'venta_anulada',
        -ABS(v_pago.monto),
        v_pago.metodo,
        'Reverso por reapertura de venta #' || v_venta.numero_local,
        p_venta_id,
        'reverso_reopen_' || p_venta_id || '_' || v_pago.id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
    ELSE
      INSERT INTO reversos_pendientes (
        tenant_id, local_id, venta_id, pago_id, empleado_id,
        metodo, monto, motivo, idempotency_key
      ) VALUES (
        v_venta.tenant_id, v_venta.local_id, p_venta_id, v_pago.id,
        COALESCE(v_pago.cobrado_por, v_empleado),
        v_pago.metodo, v_pago.monto,
        'Reverso pendiente por reapertura de venta #' || v_venta.numero_local,
        'reverso_reopen_' || p_venta_id || '_' || v_pago.id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;

    UPDATE ventas_pos_pagos
       SET estado = 'reembolsado', deleted_at = NOW()
     WHERE id = v_pago.id;
  END LOOP;

  UPDATE ventas_pos SET estado = 'enviada', cobrada_at = NULL, updated_at = NOW()
   WHERE id = p_venta_id;

  -- 3. La mesa vuelve a estar ocupada por esta venta.
  IF v_venta.mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'ocupada' WHERE id = v_venta.mesa_id;
  END IF;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, COALESCE(v_venta.cajero_id, p_manager_id),
    p_manager_id, 'reopen', p_motivo, v_venta.total
  );
END;
$function$;
