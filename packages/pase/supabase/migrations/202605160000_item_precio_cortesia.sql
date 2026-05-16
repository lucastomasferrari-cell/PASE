-- ─── Item: modificar precio puntual + cortesía 100% off ─────────────────────
-- 2 RPCs con manager override + flag es_cortesia en ventas_pos_items.
-- - fn_modificar_precio_item_comanda: cambia precio_unitario con motivo.
-- - fn_cortesia_item_comanda: marca item como cortesía (precio 0 + flag).
--
-- NOTA: ventas_pos_overrides usa columnas `accion`, `venta_item_id`,
-- `metadata` (no `tipo`, `item_id`, `payload`). El CHECK constraint de
-- accion solo acepta valores existentes: usamos 'discount' (precio) y
-- 'comp' (cortesía), con subtype en metadata para distinguir el caso.
-- Cajero requerido en overrides (FK rrhh_empleados): lo sacamos de la
-- venta o usamos el manager como fallback.

ALTER TABLE ventas_pos_items ADD COLUMN IF NOT EXISTS es_cortesia BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ventas_pos_items ADD COLUMN IF NOT EXISTS precio_unitario_original NUMERIC(12,2) NULL;

COMMENT ON COLUMN ventas_pos_items.es_cortesia IS 'TRUE si fue marcado como cortesía (regalado) — afecta CMV y reportes.';
COMMENT ON COLUMN ventas_pos_items.precio_unitario_original IS 'Precio cuando se cargó originalmente. Se llena al modificar precio para audit.';

DROP FUNCTION IF EXISTS fn_modificar_precio_item_comanda(INTEGER, NUMERIC, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS fn_cortesia_item_comanda(INTEGER, UUID, TEXT, TEXT);

-- ─── fn_modificar_precio_item_comanda ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_modificar_precio_item_comanda(
  p_item_id INTEGER,
  p_nuevo_precio NUMERIC,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_precio_actual NUMERIC;
  v_cajero UUID;
  v_estado TEXT;
  v_idem_existe BOOLEAN;
BEGIN
  IF auth_tenant_id() IS NULL THEN RAISE EXCEPTION 'SIN_TENANT'; END IF;
  IF p_nuevo_precio < 0 THEN RAISE EXCEPTION 'PRECIO_NEGATIVO'; END IF;
  IF length(coalesce(p_motivo, '')) < 5 THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM idempotency_keys
       WHERE rpc_name = 'fn_modificar_precio_item_comanda' AND key = p_idempotency_key
    ) INTO v_idem_existe;
    IF v_idem_existe THEN RETURN; END IF;
  END IF;

  SELECT vpi.venta_id, vpi.precio_unitario, vpi.estado, v.local_id, v.cajero_id
    INTO v_venta_id, v_precio_actual, v_estado, v_local_id, v_cajero
    FROM ventas_pos_items vpi
    JOIN ventas_pos v ON v.id = vpi.venta_id
   WHERE vpi.id = p_item_id
   FOR UPDATE;

  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_EXISTE'; END IF;
  IF v_estado = 'anulado' THEN RAISE EXCEPTION 'ITEM_ANULADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  PERFORM 1 FROM rrhh_empleados WHERE id = p_manager_id AND activo = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGER_NO_VALIDO'; END IF;

  UPDATE ventas_pos_items SET
    precio_unitario = p_nuevo_precio,
    precio_unitario_original = COALESCE(precio_unitario_original, v_precio_actual),
    subtotal = p_nuevo_precio * cantidad,
    updated_at = NOW()
  WHERE id = p_item_id;

  PERFORM fn_recalc_total_venta(v_venta_id);

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, venta_item_id,
    cajero_id, manager_id, accion, motivo,
    valor_anterior, valor_nuevo, monto_afectado, metadata
  ) VALUES (
    auth_tenant_id(), v_local_id, v_venta_id, p_item_id,
    COALESCE(v_cajero, p_manager_id), p_manager_id, 'discount', p_motivo,
    v_precio_actual, p_nuevo_precio, (p_nuevo_precio - v_precio_actual),
    jsonb_build_object('subtype', 'modificar_precio_item')
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id)
    VALUES ('fn_modificar_precio_item_comanda', p_idempotency_key, auth_tenant_id())
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_modificar_precio_item_comanda(INTEGER, NUMERIC, UUID, TEXT, TEXT) TO authenticated;

-- ─── fn_cortesia_item_comanda ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cortesia_item_comanda(
  p_item_id INTEGER,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_precio_actual NUMERIC;
  v_cantidad NUMERIC;
  v_cajero UUID;
  v_estado TEXT;
  v_idem_existe BOOLEAN;
BEGIN
  IF auth_tenant_id() IS NULL THEN RAISE EXCEPTION 'SIN_TENANT'; END IF;
  IF length(coalesce(p_motivo, '')) < 5 THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM idempotency_keys
       WHERE rpc_name = 'fn_cortesia_item_comanda' AND key = p_idempotency_key
    ) INTO v_idem_existe;
    IF v_idem_existe THEN RETURN; END IF;
  END IF;

  SELECT vpi.venta_id, vpi.precio_unitario, vpi.cantidad, vpi.estado, v.local_id, v.cajero_id
    INTO v_venta_id, v_precio_actual, v_cantidad, v_estado, v_local_id, v_cajero
    FROM ventas_pos_items vpi
    JOIN ventas_pos v ON v.id = vpi.venta_id
   WHERE vpi.id = p_item_id
   FOR UPDATE;

  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_EXISTE'; END IF;
  IF v_estado = 'anulado' THEN RAISE EXCEPTION 'ITEM_ANULADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  PERFORM 1 FROM rrhh_empleados WHERE id = p_manager_id AND activo = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGER_NO_VALIDO'; END IF;

  UPDATE ventas_pos_items SET
    precio_unitario_original = COALESCE(precio_unitario_original, v_precio_actual),
    precio_unitario = 0,
    subtotal = 0,
    es_cortesia = TRUE,
    updated_at = NOW()
  WHERE id = p_item_id;

  PERFORM fn_recalc_total_venta(v_venta_id);

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, venta_item_id,
    cajero_id, manager_id, accion, motivo,
    valor_anterior, valor_nuevo, monto_afectado, metadata
  ) VALUES (
    auth_tenant_id(), v_local_id, v_venta_id, p_item_id,
    COALESCE(v_cajero, p_manager_id), p_manager_id, 'comp', p_motivo,
    v_precio_actual * v_cantidad, 0, -(v_precio_actual * v_cantidad),
    jsonb_build_object('subtype', 'cortesia_item')
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id)
    VALUES ('fn_cortesia_item_comanda', p_idempotency_key, auth_tenant_id())
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cortesia_item_comanda(INTEGER, UUID, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
