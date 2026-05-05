-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 4 — Sesión A
-- Cierra el ciclo operativo del POS:
--   - Storage bucket mp-qrs (subida de QR de MercadoPago por local)
--   - fn_unir_mesas_comanda
--   - fn_partir_cuenta_comanda (versión simple por items)
--   - fn_agregar_pago_venta_comanda (multi-pago idempotente)
--   - fn_recalcular_totales_venta_comanda (helper público)
--
-- Sprint 2 ya creó: fn_anular_item_comanda, fn_anular_venta_comanda,
-- fn_aplicar_descuento_comanda, fn_movimiento_caja_comanda,
-- fn_transferir_mesa_comanda, fn_aprobar_pedido_comanda, etc. NO se duplican.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Storage bucket mp-qrs ────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('mp-qrs', 'mp-qrs', true)
ON CONFLICT (id) DO NOTHING;

-- Policies de storage.objects ya existen del Sprint COMANDA tienda. Acá
-- agregamos solo lo específico de mp-qrs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'mp_qrs_authenticated_upload') THEN
    CREATE POLICY mp_qrs_authenticated_upload
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'mp-qrs'
        AND auth_tenant_id() IS NOT NULL
        AND (storage.foldername(name))[1] = auth_tenant_id()::text
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'mp_qrs_authenticated_update') THEN
    CREATE POLICY mp_qrs_authenticated_update
      ON storage.objects FOR UPDATE TO authenticated
      USING (
        bucket_id = 'mp-qrs'
        AND (storage.foldername(name))[1] = auth_tenant_id()::text
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'mp_qrs_authenticated_delete') THEN
    CREATE POLICY mp_qrs_authenticated_delete
      ON storage.objects FOR DELETE TO authenticated
      USING (
        bucket_id = 'mp-qrs'
        AND (storage.foldername(name))[1] = auth_tenant_id()::text
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'mp_qrs_public_read') THEN
    CREATE POLICY mp_qrs_public_read
      ON storage.objects FOR SELECT TO anon, authenticated
      USING (bucket_id = 'mp-qrs');
  END IF;
END $$;

-- ─── 2. fn_recalcular_totales_venta_comanda ───────────────────────────────
-- Helper público. Sprint 2 tenía fn_recalc_total_venta privada (ahora la
-- exponemos con un nombre canónico que los services pueden llamar).
CREATE OR REPLACE FUNCTION fn_recalcular_totales_venta_comanda(p_venta_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_subtotal NUMERIC;
BEGIN
  SELECT COALESCE(SUM(subtotal - descuento), 0) INTO v_subtotal
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';
  UPDATE ventas_pos SET
    subtotal = v_subtotal,
    total = v_subtotal - descuento_total + propina,
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_recalcular_totales_venta_comanda(BIGINT) TO authenticated;

-- ─── 3. fn_agregar_pago_venta_comanda — multi-pago idempotente ─────────────
-- Permite registrar pagos parciales hasta cubrir el total. Cuando la suma
-- de pagos confirmados >= total, marca venta como cobrada automáticamente.
-- El idempotency_key (UNIQUE) previene duplicados si el cliente re-envía.
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
  -- Idempotency check
  SELECT id INTO v_pago_id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key;
  IF v_pago_id IS NOT NULL THEN RETURN v_pago_id; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta.estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_venta.estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  -- Insertar pago confirmado
  INSERT INTO ventas_pos_pagos (
    tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
    cobrado_por, vuelto, propina_incluida, estado, confirmado_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, p_metodo, p_monto, p_idempotency_key,
    COALESCE(p_cobrado_por, v_venta.cajero_id), p_vuelto, COALESCE(p_propina_incluida, 0),
    'confirmado', NOW()
  ) RETURNING id INTO v_pago_id;

  -- Si la suma de pagos cubre el total, marcar venta cobrada + mov caja
  SELECT COALESCE(SUM(monto), 0) INTO v_total_pagado
    FROM ventas_pos_pagos
   WHERE venta_id = p_venta_id AND estado = 'confirmado';

  IF v_total_pagado >= v_venta.total - 0.01 THEN
    UPDATE ventas_pos SET
      estado = 'cobrada',
      cobrada_at = NOW(),
      updated_at = NOW()
    WHERE id = p_venta_id;

    -- Liberar mesa si hay
    IF v_venta.mesa_id IS NOT NULL THEN
      UPDATE mesas SET estado = 'libre' WHERE id = v_venta.mesa_id;
    END IF;
  END IF;

  -- Movimiento de caja (1 por pago)
  v_local_id := v_venta.local_id;
  v_turno_id := v_venta.turno_caja_id;
  IF v_turno_id IS NOT NULL THEN
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id, tipo,
      monto, metodo, motivo, venta_id
    ) VALUES (
      v_venta.tenant_id, v_local_id, v_turno_id,
      COALESCE(p_cobrado_por, (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
      'venta', p_monto, p_metodo,
      'Cobro venta #' || p_venta_id, p_venta_id
    );
  END IF;

  RETURN v_pago_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_agregar_pago_venta_comanda(BIGINT, TEXT, NUMERIC, TEXT, UUID, NUMERIC, NUMERIC) TO authenticated;

-- ─── 4. fn_unir_mesas_comanda ─────────────────────────────────────────────
-- Junta 2 ventas en 1: items de venta_origen pasan a venta_destino, mesa
-- origen queda libre, venta_origen queda anulada con motivo.
CREATE OR REPLACE FUNCTION fn_unir_mesas_comanda(
  p_venta_origen_id BIGINT,
  p_venta_destino_id BIGINT,
  p_manager_id UUID,
  p_motivo TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_origen ventas_pos%ROWTYPE;
  v_destino ventas_pos%ROWTYPE;
  v_cajero UUID;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
  ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;

  SELECT * INTO v_origen FROM ventas_pos WHERE id = p_venta_origen_id;
  SELECT * INTO v_destino FROM ventas_pos WHERE id = p_venta_destino_id;
  IF v_origen IS NULL OR v_destino IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_origen.id = v_destino.id THEN RAISE EXCEPTION 'VENTAS_IGUALES'; END IF;
  IF v_origen.estado = 'cobrada' OR v_destino.estado = 'cobrada' THEN
    RAISE EXCEPTION 'NO_SE_PUEDE_UNIR_VENTA_COBRADA';
  END IF;

  -- Mover items
  UPDATE ventas_pos_items SET venta_id = p_venta_destino_id, updated_at = NOW()
   WHERE venta_id = p_venta_origen_id AND estado != 'anulado';

  -- Anular venta origen
  UPDATE ventas_pos SET
    estado = 'anulada', anulada_at = NOW(),
    notas = COALESCE(notas, '') || E'\nUnida a venta #' || p_venta_destino_id,
    updated_at = NOW()
  WHERE id = p_venta_origen_id;

  -- Liberar mesa origen
  IF v_origen.mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_origen.mesa_id;
  END IF;

  -- Recalcular totales destino
  PERFORM fn_recalcular_totales_venta_comanda(p_venta_destino_id);

  -- Audit
  v_cajero := COALESCE(v_destino.cajero_id, p_manager_id);
  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id,
    accion, motivo, metadata
  ) VALUES (
    v_destino.tenant_id, v_destino.local_id, p_venta_destino_id, v_cajero, p_manager_id,
    'merge_mesas', p_motivo,
    jsonb_build_object('venta_origen_id', p_venta_origen_id, 'mesa_origen_id', v_origen.mesa_id)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION fn_unir_mesas_comanda(BIGINT, BIGINT, UUID, TEXT) TO authenticated;

-- ─── 5. fn_partir_cuenta_comanda ──────────────────────────────────────────
-- Versión simple: recibe array de item IDs que se MUEVEN a una nueva venta
-- (misma mesa, mozo, canal). La venta original queda con los items
-- restantes; si quedó vacía, se anula. Audit: split_check en venta nueva.
CREATE OR REPLACE FUNCTION fn_partir_cuenta_comanda(
  p_venta_id BIGINT,
  p_item_ids BIGINT[],
  p_manager_id UUID,
  p_motivo TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_nueva_id BIGINT;
  v_numero INTEGER;
  v_remaining INTEGER;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF array_length(p_item_ids, 1) IS NULL OR array_length(p_item_ids, 1) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUERIDOS';
  END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta.estado IN ('cobrada','anulada') THEN
    RAISE EXCEPTION 'VENTA_NO_EDITABLE';
  END IF;

  -- Crear nueva venta hermana
  v_numero := fn_next_ticket_number_comanda(v_venta.local_id);
  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id, turno_caja_id,
    mesa_id, mozo_id, cajero_id, cliente_nombre, covers,
    estado, origen, abierta_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, v_numero, v_venta.modo, v_venta.canal_id, v_venta.turno_caja_id,
    v_venta.mesa_id, v_venta.mozo_id, v_venta.cajero_id, v_venta.cliente_nombre, v_venta.covers,
    'abierta', v_venta.origen, NOW()
  ) RETURNING id INTO v_nueva_id;

  -- Mover items seleccionados
  UPDATE ventas_pos_items SET venta_id = v_nueva_id, updated_at = NOW()
   WHERE id = ANY(p_item_ids) AND venta_id = p_venta_id;

  -- Recalcular ambas
  PERFORM fn_recalcular_totales_venta_comanda(p_venta_id);
  PERFORM fn_recalcular_totales_venta_comanda(v_nueva_id);

  -- Si la venta original quedó sin items activos, anularla
  SELECT COUNT(*) INTO v_remaining FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';
  IF v_remaining = 0 THEN
    UPDATE ventas_pos SET
      estado = 'anulada', anulada_at = NOW(),
      notas = COALESCE(notas, '') || E'\nPartida en venta #' || v_nueva_id
    WHERE id = p_venta_id;
  END IF;

  -- Audit en venta nueva
  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id,
    accion, motivo, metadata
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, v_nueva_id, v_venta.cajero_id, p_manager_id,
    'split_check', p_motivo,
    jsonb_build_object('venta_origen_id', p_venta_id, 'item_ids', p_item_ids)
  );

  RETURN v_nueva_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_partir_cuenta_comanda(BIGINT, BIGINT[], UUID, TEXT) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN COMANDA Sprint 4 — Sesión A
-- ═══════════════════════════════════════════════════════════════════════════
