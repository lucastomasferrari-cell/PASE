-- ═══════════════════════════════════════════════════════════════════════════
-- F1.5 — Auth check (C11) en 5 RPCs sprint 2 que eran SECURITY DEFINER sin
-- verificación de local_id intra-tenant.
--
-- Detectado en auditoría estructural 2026-05-15: estas RPCs solo confiaban en
-- RLS (que cubre tenant) pero permitían IDOR intra-tenant — un cajero del
-- Local A podría modificar mesa/venta del Local B del mismo tenant.
--
-- RPCs afectadas:
--   1. fn_modificar_item_comanda    — sprint 2 sin assert local
--   2. fn_mandar_curso_comanda      — sprint 2 sin assert local
--   3. fn_transferir_mesa_comanda   — sprint 2 sin assert local + assert mesa destino
--   4. fn_unir_mesas_comanda        — sprint 4A sin assert local de ambas
--   5. fn_partir_cuenta_comanda     — sprint 4A sin assert local
--
-- Helper usado: fn_assert_local_autorizado(p_local_id INTEGER)
-- (definido en migration 202605091210 sprint 7).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. fn_modificar_item_comanda — agrega assert local ────────────────────
CREATE OR REPLACE FUNCTION fn_modificar_item_comanda(
  p_item_id BIGINT,
  p_cantidad NUMERIC DEFAULT NULL,
  p_curso INTEGER DEFAULT NULL,
  p_notas TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_pu NUMERIC;
  v_estado TEXT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT venta_id, local_id, precio_unitario, estado
    INTO v_venta_id, v_local_id, v_pu, v_estado
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  -- F1.5: IDOR fix — verificar que el caller puede operar en ESE local.
  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado IN ('enviado','listo','entregado','anulado') THEN
    RAISE EXCEPTION 'ITEM_NO_EDITABLE: estado %', v_estado;
  END IF;

  UPDATE ventas_pos_items SET
    cantidad = COALESCE(p_cantidad, cantidad),
    subtotal = COALESCE(p_cantidad, cantidad) * v_pu,
    curso    = COALESCE(p_curso, curso),
    notas    = COALESCE(p_notas, notas),
    updated_at = NOW()
  WHERE id = p_item_id;

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;

-- ─── 2. fn_mandar_curso_comanda — agrega assert local ──────────────────────
CREATE OR REPLACE FUNCTION fn_mandar_curso_comanda(
  p_venta_id BIGINT,
  p_curso INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_local_id INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- F1.5: IDOR fix.
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos_items SET
    estado = 'enviado', enviado_at = NOW(), updated_at = NOW()
  WHERE venta_id = p_venta_id AND curso = p_curso
    AND estado = 'hold' AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    UPDATE ventas_pos SET
      estado = CASE WHEN estado = 'abierta' THEN 'enviada' ELSE estado END,
      enviada_at = COALESCE(enviada_at, NOW()),
      updated_at = NOW()
    WHERE id = p_venta_id;
  END IF;
  RETURN v_count;
END;
$$;

-- ─── 3. fn_transferir_mesa_comanda — agrega assert local + mesa destino ───
CREATE OR REPLACE FUNCTION fn_transferir_mesa_comanda(
  p_venta_id BIGINT,
  p_mesa_destino BIGINT,
  p_manager_id UUID,
  p_motivo TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
  v_mesa_origen BIGINT;
  v_mesa_destino_local INTEGER;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;

  SELECT local_id, mesa_id INTO v_local_id, v_mesa_origen
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- F1.5: IDOR fix — local de la venta.
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- F1.5: la mesa destino debe ser del MISMO local. Sin esta verificación,
  -- un cajero del Local A podría transferir una venta a una mesa del Local B.
  SELECT local_id INTO v_mesa_destino_local FROM mesas WHERE id = p_mesa_destino;
  IF v_mesa_destino_local IS NULL THEN RAISE EXCEPTION 'MESA_DESTINO_NO_ENCONTRADA'; END IF;
  IF v_mesa_destino_local != v_local_id THEN
    RAISE EXCEPTION 'MESA_DESTINO_CROSS_LOCAL: mesa % no pertenece al local %', p_mesa_destino, v_local_id;
  END IF;

  UPDATE ventas_pos SET mesa_id = p_mesa_destino, updated_at = NOW()
   WHERE id = p_venta_id;
  IF v_mesa_origen IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_origen;
  END IF;
  UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_destino;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
    metadata
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, p_manager_id, p_manager_id,
    'transfer_table', p_motivo,
    jsonb_build_object('mesa_origen', v_mesa_origen, 'mesa_destino', p_mesa_destino)
  );
END;
$$;

-- ─── 4. fn_unir_mesas_comanda — agrega assert local de ambas ──────────────
CREATE OR REPLACE FUNCTION fn_unir_mesas_comanda(
  p_venta_origen_id BIGINT,
  p_venta_destino_id BIGINT,
  p_manager_id UUID,
  p_motivo TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- F1.5: IDOR fix — ambas ventas deben ser del MISMO local Y autorizado.
  IF v_origen.local_id != v_destino.local_id THEN
    RAISE EXCEPTION 'VENTAS_CROSS_LOCAL: origen local % != destino local %',
      v_origen.local_id, v_destino.local_id;
  END IF;
  PERFORM fn_assert_local_autorizado(v_origen.local_id);

  UPDATE ventas_pos_items SET venta_id = p_venta_destino_id, updated_at = NOW()
   WHERE venta_id = p_venta_origen_id AND estado != 'anulado';

  UPDATE ventas_pos SET
    estado = 'anulada', anulada_at = NOW(),
    notas = COALESCE(notas, '') || E'\nUnida a venta #' || p_venta_destino_id,
    updated_at = NOW()
  WHERE id = p_venta_origen_id;

  IF v_origen.mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_origen.mesa_id;
  END IF;

  PERFORM fn_recalcular_totales_venta_comanda(p_venta_destino_id);

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

-- ─── 5. fn_partir_cuenta_comanda — agrega assert local ────────────────────
CREATE OR REPLACE FUNCTION fn_partir_cuenta_comanda(
  p_venta_id BIGINT,
  p_item_ids BIGINT[],
  p_manager_id UUID,
  p_motivo TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- F1.5: IDOR fix.
  PERFORM fn_assert_local_autorizado(v_venta.local_id);

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

  UPDATE ventas_pos_items SET venta_id = v_nueva_id, updated_at = NOW()
   WHERE id = ANY(p_item_ids) AND venta_id = p_venta_id;

  PERFORM fn_recalcular_totales_venta_comanda(p_venta_id);
  PERFORM fn_recalcular_totales_venta_comanda(v_nueva_id);

  SELECT COUNT(*) INTO v_remaining FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';
  IF v_remaining = 0 THEN
    UPDATE ventas_pos SET
      estado = 'anulada', anulada_at = NOW(),
      notas = COALESCE(notas, '') || E'\nPartida en venta #' || v_nueva_id
    WHERE id = p_venta_id;
  END IF;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN F1.5
-- ═══════════════════════════════════════════════════════════════════════════
