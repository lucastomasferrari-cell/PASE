-- ═══════════════════════════════════════════════════════════════════════════
-- BUG FIX — cobrar venta sin turno de caja abierto dejaba plata "flotando"
-- ═══════════════════════════════════════════════════════════════════════════
-- Reportado el 2026-05-15: si el cajero cierra una venta SIN turno abierto,
-- la venta queda en estado 'cobrada' pero NO se genera el movimiento_caja
-- correspondiente. La plata queda fantasma — no aparece en caja ni en
-- arqueo.
--
-- Causa: ambas RPCs de cobro (fn_cobrar_venta_comanda y fn_agregar_pago_
-- venta_comanda) tenían:
--   IF v_turno_id IS NOT NULL THEN INSERT INTO movimientos_caja ... END IF;
-- Si la venta no tenía turno_caja_id (porque se creó cuando la caja estaba
-- cerrada), el cobro pasaba sin generar movimiento.
--
-- Fix:
--   1. Resolver v_turno_id ANTES del cobro:
--      - Si la venta tiene turno_caja_id seteado, usar ese.
--      - Si NULL, buscar el turno abierto en el local de la venta y asignarlo.
--      - Si tampoco hay turno abierto → RAISE 'NO_HAY_TURNO_ABIERTO' y abortar
--        el cobro. El cajero tiene que abrir caja primero.
--   2. Actualizar la venta con el turno asignado (si vino NULL).
--
-- Mantengo F1.1c snapshot CMV + F1.6b idempotency + IDOR del sprint 7.

-- ─── 1. fn_cobrar_venta_comanda con assert de turno ─────────────────────
DROP FUNCTION IF EXISTS fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID, TEXT);

CREATE OR REPLACE FUNCTION fn_cobrar_venta_comanda(
  p_venta_id BIGINT,
  p_pagos JSONB,
  p_propina NUMERIC DEFAULT 0,
  p_cobrado_por UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
  v_total NUMERIC;
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_suma_pagos NUMERIC := 0;
  v_pago JSONB;
  v_turno_id BIGINT;
  v_mesa_id BIGINT;
  v_existing_key TEXT;
  v_item RECORD;
  v_version_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  -- IDEMPOTENCY a nivel header.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT cobro_idempotency_key, total INTO v_existing_key, v_total
    FROM ventas_pos WHERE id = p_venta_id;
    IF v_existing_key = p_idempotency_key THEN
      RETURN COALESCE(v_total, 0);
    END IF;
  END IF;

  SELECT local_id, estado, subtotal, descuento_total, turno_caja_id, mesa_id
    INTO v_local_id, v_estado, v_subtotal, v_descuento, v_turno_id, v_mesa_id
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  -- FIX 2026-05-15: si la venta no tiene turno asignado, buscar el turno
  -- abierto del local. Si tampoco hay, abortar — plata no puede quedar
  -- flotando sin arqueo.
  IF v_turno_id IS NULL THEN
    SELECT id INTO v_turno_id FROM turnos_caja
     WHERE local_id = v_local_id AND estado = 'abierto' LIMIT 1;
    IF v_turno_id IS NULL THEN
      RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
    END IF;
    -- Asignar el turno a la venta para que quede consistente.
    UPDATE ventas_pos SET turno_caja_id = v_turno_id WHERE id = p_venta_id;
  END IF;

  v_total := v_subtotal - v_descuento + COALESCE(p_propina, 0);
  v_total := GREATEST(0, v_total);

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_suma_pagos := v_suma_pagos + COALESCE((v_pago->>'monto')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_suma_pagos - v_total) > 0.01 THEN
    RAISE EXCEPTION 'SUMA_PAGOS_NO_COINCIDE: suma=% total=%', v_suma_pagos, v_total;
  END IF;

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO ventas_pos_pagos (
      tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
      vuelto, propina_incluida, cobrado_por, estado, confirmado_at
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id,
      v_pago->>'metodo',
      (v_pago->>'monto')::NUMERIC,
      v_pago->>'idempotency_key',
      NULLIF((v_pago->>'vuelto'),'')::NUMERIC,
      COALESCE((v_pago->>'propina_incluida')::NUMERIC, 0),
      p_cobrado_por,
      'confirmado',
      NOW()
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  -- F1.1c: snapshot de receta por item (best-effort).
  FOR v_item IN
    SELECT id, item_id FROM ventas_pos_items
    WHERE venta_id = p_venta_id
      AND deleted_at IS NULL
      AND estado <> 'anulado'
      AND receta_version_id IS NULL
  LOOP
    BEGIN
      v_version_id := fn_snapshot_receta_a_version(v_item.item_id);
      IF v_version_id IS NOT NULL THEN
        UPDATE ventas_pos_items SET receta_version_id = v_version_id WHERE id = v_item.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'F1.1c snapshot falló item_id=%, venta_id=%: %', v_item.item_id, p_venta_id, SQLERRM;
    END;
  END LOOP;

  UPDATE ventas_pos SET
    estado = 'cobrada', propina = COALESCE(p_propina, 0),
    cobrada_at = NOW(),
    total = v_total,
    cobro_idempotency_key = COALESCE(p_idempotency_key, cobro_idempotency_key),
    updated_at = NOW()
  WHERE id = p_venta_id;

  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Insertar movimientos_caja — ahora v_turno_id NUNCA es NULL.
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id, tipo,
      monto, metodo, motivo, venta_id
    ) VALUES (
      auth_tenant_id(), v_local_id, v_turno_id, COALESCE(p_cobrado_por,
        (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
      'venta', (v_pago->>'monto')::NUMERIC, v_pago->>'metodo',
      'Cobro venta #' || p_venta_id, p_venta_id
    );
  END LOOP;

  RETURN v_total;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID, TEXT) TO authenticated;

-- ─── 2. fn_agregar_pago_venta_comanda con assert de turno ───────────────
DROP FUNCTION IF EXISTS fn_agregar_pago_venta_comanda(BIGINT, TEXT, NUMERIC, TEXT, UUID, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION fn_agregar_pago_venta_comanda(
  p_venta_id BIGINT,
  p_metodo TEXT,
  p_monto NUMERIC,
  p_idempotency_key TEXT,
  p_cobrado_por UUID DEFAULT NULL,
  p_vuelto NUMERIC DEFAULT NULL,
  p_propina_incluida NUMERIC DEFAULT 0
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_pago_id BIGINT;
  v_total_pagado NUMERIC;
  v_local_id INTEGER;
  v_turno_id BIGINT;
BEGIN
  SELECT id INTO v_pago_id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key;
  IF v_pago_id IS NOT NULL THEN RETURN v_pago_id; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta.estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_venta.estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  -- FIX 2026-05-15: resolver turno antes del INSERT a pagos.
  v_turno_id := v_venta.turno_caja_id;
  IF v_turno_id IS NULL THEN
    SELECT id INTO v_turno_id FROM turnos_caja
     WHERE local_id = v_venta.local_id AND estado = 'abierto' LIMIT 1;
    IF v_turno_id IS NULL THEN
      RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
    END IF;
    UPDATE ventas_pos SET turno_caja_id = v_turno_id WHERE id = p_venta_id;
  END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_total_pagado
    FROM ventas_pos_pagos
   WHERE venta_id = p_venta_id AND estado = 'confirmado';

  IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN
    RAISE EXCEPTION 'SOBREPAGO: cobrarías % cuando faltan %',
      p_monto, GREATEST(0, v_venta.total - v_total_pagado);
  END IF;

  INSERT INTO ventas_pos_pagos (
    tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
    cobrado_por, vuelto, propina_incluida, estado, confirmado_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, p_metodo, p_monto, p_idempotency_key,
    COALESCE(p_cobrado_por, v_venta.cajero_id), p_vuelto, COALESCE(p_propina_incluida, 0),
    'confirmado', NOW()
  ) RETURNING id INTO v_pago_id;

  IF v_total_pagado + p_monto >= v_venta.total - 0.01 THEN
    UPDATE ventas_pos SET
      estado = 'cobrada', cobrada_at = NOW(), updated_at = NOW()
    WHERE id = p_venta_id;

    IF v_venta.mesa_id IS NOT NULL THEN
      UPDATE mesas SET estado = 'libre' WHERE id = v_venta.mesa_id;
    END IF;
  END IF;

  v_local_id := v_venta.local_id;
  -- v_turno_id ya garantizado != NULL arriba.
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

  RETURN v_pago_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_agregar_pago_venta_comanda(BIGINT, TEXT, NUMERIC, TEXT, UUID, NUMERIC, NUMERIC) TO authenticated;
