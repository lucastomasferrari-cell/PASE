-- anular_movimiento: bloquear anulación desde Caja de movimientos vinculados (01-ago)
-- Auditoría H1: anular desde Caja el pago de factura/remito/gasto/adelanto/pago
-- especial revertía la caja pero dejaba el documento "pagado" (desync). Ahora se
-- bloquea y se manda a anular desde el módulo de origen. Se conserva el resto de
-- la función (sueldos + patas de transferencia) intacto.

CREATE OR REPLACE FUNCTION public.anular_movimiento(p_mov_id text, p_motivo text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov RECORD;
  v_liq RECORD;
  v_emp_id uuid;
  v_movs_restantes integer;
  v_delta_aguinaldo numeric;
  v_tenant uuid;
  v_hermanas integer := 0;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_movimiento',
    jsonb_build_object('mov_id', p_mov_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;
  v_tenant := v_mov.tenant_id;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  -- Fix auditoría 01-ago (H1): NO permitir anular desde Caja un movimiento que
  -- es el pago de una factura/remito/gasto/adelanto/pago especial — antes la
  -- caja se revertía pero el documento quedaba "pagado" (desync de cuentas por
  -- pagar). Se bloquea y se manda a anular desde el módulo de origen, que ya
  -- revierte correctamente. (liquidacion_id y transferencia_id SÍ se manejan acá.)
  IF v_mov.fact_id IS NOT NULL THEN RAISE EXCEPTION 'MOV_VINCULADO_FACTURA'; END IF;
  IF v_mov.remito_id_ref IS NOT NULL THEN RAISE EXCEPTION 'MOV_VINCULADO_REMITO'; END IF;
  IF v_mov.gasto_id_ref IS NOT NULL THEN RAISE EXCEPTION 'MOV_VINCULADO_GASTO'; END IF;
  IF v_mov.adelanto_id_ref IS NOT NULL THEN RAISE EXCEPTION 'MOV_VINCULADO_ADELANTO'; END IF;
  IF v_mov.pago_especial_id_ref IS NOT NULL THEN RAISE EXCEPTION 'MOV_VINCULADO_PAGO_ESPECIAL'; END IF;

  -- FIX 09-jun (aguinaldo fantasma, hallazgo del re-test de mutantes): leer y
  -- lockear la liquidación ANTES de anular el movimiento. El trigger
  -- trg_sync_pagos_rrhh (22-may) pone liq.estado='pendiente' al procesar el
  -- UPDATE de abajo, lo que dejaba MUERTA la rama IF estado='pagado' que
  -- revierte el aguinaldo → cada pagar→anular→re-pagar inflaba
  -- aguinaldo_acumulado en subtotal2/12.
  IF v_mov.liquidacion_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = v_mov.liquidacion_id FOR UPDATE;
  END IF;

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- ★ NUEVO 09-jun (sprint anti-huérfanos): si es una pata de transferencia,
  -- anular también la(s) pata(s) hermana(s) para no dejar media transferencia.
  IF v_mov.transferencia_id IS NOT NULL THEN
    UPDATE movimientos
       SET anulado = true,
           anulado_motivo = COALESCE(p_motivo, 'Anulación de la pata hermana de la transferencia')
     WHERE transferencia_id = v_mov.transferencia_id
       AND id <> p_mov_id
       AND COALESCE(anulado, false) = false;
    GET DIAGNOSTICS v_hermanas = ROW_COUNT;
  END IF;

  -- Si el movimiento estaba asociado a una liquidación de sueldo: lógica completa.
  IF v_mov.liquidacion_id IS NOT NULL THEN
    -- (v_liq ya capturada y lockeada ANTES del UPDATE movimientos — ver arriba)

    SELECT COUNT(*) INTO v_movs_restantes
      FROM movimientos
     WHERE liquidacion_id = v_mov.liquidacion_id AND anulado IS NOT TRUE;

    IF v_movs_restantes = 0 THEN
      IF v_liq.estado = 'pagado' THEN
        SELECT n.empleado_id INTO v_emp_id
          FROM rrhh_novedades n
         WHERE n.id = v_liq.novedad_id;
        IF v_emp_id IS NOT NULL THEN
          -- AUDIT 09-jun (H1): revertir con la MISMA base que acumula pagar_sueldo
          -- (subtotal2 = bruto, fix 202606072300). Antes restaba total_a_pagar/12
          -- (neto) y cada ciclo pagar→anular dejaba aguinaldo fantasma cuando
          -- había adelantos.
          v_delta_aguinaldo := COALESCE(v_liq.subtotal2, v_liq.total_a_pagar, 0) / 12.0;
          UPDATE rrhh_empleados
             SET aguinaldo_acumulado = GREATEST(0, COALESCE(aguinaldo_acumulado, 0) - v_delta_aguinaldo)
           WHERE id = v_emp_id;
        END IF;
      END IF;

      UPDATE rrhh_adelantos
         SET descontado = false,
             liquidacion_consumidora_id = NULL
       WHERE liquidacion_consumidora_id = v_mov.liquidacion_id;

      UPDATE rrhh_liquidaciones
         SET anulado = true,
             pagos_realizados = 0,
             estado = 'pendiente'
       WHERE id = v_mov.liquidacion_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'mov_id', p_mov_id,
    'anulado', true,
    'patas_hermanas_anuladas', v_hermanas
  );
END;
$function$

