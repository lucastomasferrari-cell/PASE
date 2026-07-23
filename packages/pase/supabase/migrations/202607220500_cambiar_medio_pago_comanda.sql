-- D (COMANDA): corregir el MEDIO DE PAGO de una venta ya cobrada, cuando el
-- cajero eligió uno equivocado. Atómico: actualiza el pago Y reclasifica el
-- movimiento de caja (así el efectivo/arqueo del turno queda bien).
--
-- Reglas (decididas con Lucas):
--  · Solo con el TURNO ABIERTO (nunca toca un arqueo ya cerrado).
--  · Solo admin/manager (requiere p_manager_id, como reabrir).

-- 1. Permitir la acción nueva en la auditoría (ventas_pos_overrides.accion).
ALTER TABLE public.ventas_pos_overrides DROP CONSTRAINT IF EXISTS ventas_pos_overrides_accion_check;
ALTER TABLE public.ventas_pos_overrides ADD CONSTRAINT ventas_pos_overrides_accion_check
  CHECK (accion = ANY (ARRAY[
    'void','comp','discount','refund','reopen','transfer_table','cambio_mozo',
    'merge_mesas','split_check','retiro_caja','deposito_caja','cambio_medio'
  ]));

-- 2. El RPC.
CREATE OR REPLACE FUNCTION public.fn_cambiar_medio_pago_comanda(
  p_pago_id bigint, p_nuevo_metodo text, p_manager_id uuid, p_motivo text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pago ventas_pos_pagos%ROWTYPE;
  v_venta ventas_pos%ROWTYPE;
  v_turno_estado TEXT;
  v_mov_id BIGINT;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF p_nuevo_metodo IS NULL OR btrim(p_nuevo_metodo) = '' THEN RAISE EXCEPTION 'METODO_REQUERIDO'; END IF;

  -- Pago confirmado (cobrado) y vivo.
  SELECT * INTO v_pago FROM ventas_pos_pagos
   WHERE id = p_pago_id AND estado = 'confirmado' AND deleted_at IS NULL;
  IF v_pago.id IS NULL THEN RAISE EXCEPTION 'PAGO_NO_ENCONTRADO'; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = v_pago.venta_id;
  IF v_venta.id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- IDOR: la venta debe ser de un local autorizado para el caller.
  PERFORM fn_assert_local_autorizado(v_venta.local_id);

  -- El nuevo método tiene que existir en el catálogo del tenant.
  IF NOT EXISTS (
    SELECT 1 FROM medios_cobro
     WHERE slug = p_nuevo_metodo AND tenant_id = v_venta.tenant_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'METODO_INVALIDO';
  END IF;

  -- Solo con el turno ABIERTO: nunca reescribir un arqueo ya cerrado.
  IF v_venta.turno_caja_id IS NULL THEN RAISE EXCEPTION 'NO_HAY_TURNO'; END IF;
  SELECT estado INTO v_turno_estado FROM turnos_caja WHERE id = v_venta.turno_caja_id;
  IF v_turno_estado IS DISTINCT FROM 'abierto' THEN RAISE EXCEPTION 'TURNO_CERRADO'; END IF;

  -- No-op si ya es ese método.
  IF v_pago.metodo = p_nuevo_metodo THEN RETURN; END IF;

  -- Ubicar el movimiento de caja del cobro de ESTE pago para reclasificarlo.
  -- Link fuerte por idempotency_key ('mov_'||idem del pago); fallback por monto.
  SELECT id INTO v_mov_id
    FROM movimientos_caja
   WHERE venta_id = v_venta.id AND tipo = 'venta' AND metodo = v_pago.metodo
     AND (
       (v_pago.idempotency_key IS NOT NULL AND idempotency_key = 'mov_' || v_pago.idempotency_key)
       OR (v_pago.idempotency_key IS NULL AND monto = v_pago.monto)
     )
   ORDER BY created_at
   LIMIT 1;

  -- 1. Cambiar el método del pago.
  UPDATE ventas_pos_pagos
     SET metodo = p_nuevo_metodo, updated_at = NOW()
   WHERE id = p_pago_id;

  -- 2. Reclasificar el movimiento de caja (mueve la plata entre efectivo/no-efectivo).
  IF v_mov_id IS NOT NULL THEN
    UPDATE movimientos_caja SET metodo = p_nuevo_metodo WHERE id = v_mov_id;
  END IF;

  -- 3. Auditar el cambio (quién, cuándo, de qué a qué).
  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, v_venta.id,
    COALESCE(v_pago.cobrado_por, p_manager_id), p_manager_id, 'cambio_medio',
    COALESCE(NULLIF(btrim(p_motivo), ''), 'Corrección de medio')
      || ' [' || v_pago.metodo || ' → ' || p_nuevo_metodo || ']',
    v_pago.monto
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cambiar_medio_pago_comanda(bigint, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cambiar_medio_pago_comanda(bigint, text, uuid, text) TO authenticated;
