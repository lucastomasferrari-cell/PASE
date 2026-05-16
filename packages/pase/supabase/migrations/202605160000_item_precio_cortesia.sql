-- ─── Item: modificar precio puntual + cortesía 100% off ─────────────────────
-- Agrega 2 RPCs con manager override + flag es_cortesia en ventas_pos_items.
-- - fn_modificar_precio_item_comanda: cambia precio_unitario de un item con
--   motivo + manager. Recalcula subtotal del item + total venta.
-- - fn_cortesia_item_comanda: marca item como cortesía (precio_unitario=0,
--   es_cortesia=true) — caso de uso: invitar un postre por error de cocina.

-- Flag para distinguir cortesía vs precio simplemente bajo (importante para
-- reporting de "regalado vs vendido con descuento")
ALTER TABLE ventas_pos_items ADD COLUMN IF NOT EXISTS es_cortesia BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ventas_pos_items ADD COLUMN IF NOT EXISTS precio_unitario_original NUMERIC(12,2) NULL;

COMMENT ON COLUMN ventas_pos_items.es_cortesia IS 'TRUE si fue marcado como cortesía (regalado) — afecta CMV y reportes.';
COMMENT ON COLUMN ventas_pos_items.precio_unitario_original IS 'Precio cuando se cargó originalmente. Se llena al modificar precio para audit.';

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
  v_venta_id INTEGER;
  v_local_id INTEGER;
  v_precio_actual NUMERIC;
  v_cantidad NUMERIC;
  v_estado TEXT;
  v_existing_override INTEGER;
BEGIN
  -- Auth
  IF auth_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  IF p_nuevo_precio < 0 THEN
    RAISE EXCEPTION 'PRECIO_NEGATIVO';
  END IF;
  IF length(coalesce(p_motivo, '')) < 5 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_override FROM idempotency_keys
     WHERE rpc_name = 'fn_modificar_precio_item_comanda' AND key = p_idempotency_key;
    IF v_existing_override IS NOT NULL THEN
      RETURN;  -- ya procesado
    END IF;
  END IF;

  -- Lock item + venta
  SELECT vpi.venta_id, vpi.precio_unitario, vpi.cantidad, vpi.estado, v.local_id
    INTO v_venta_id, v_precio_actual, v_cantidad, v_estado, v_local_id
    FROM ventas_pos_items vpi
    JOIN ventas_pos v ON v.id = vpi.venta_id
   WHERE vpi.id = p_item_id
   FOR UPDATE;

  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_EXISTE'; END IF;
  IF v_estado = 'anulado' THEN RAISE EXCEPTION 'ITEM_ANULADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  -- Verificar manager
  PERFORM 1 FROM rrhh_empleados WHERE id = p_manager_id::TEXT AND activo = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGER_NO_VALIDO'; END IF;

  -- Update item
  UPDATE ventas_pos_items SET
    precio_unitario = p_nuevo_precio,
    precio_unitario_original = COALESCE(precio_unitario_original, v_precio_actual),
    subtotal = p_nuevo_precio * cantidad,
    updated_at = NOW()
  WHERE id = p_item_id;

  -- Recalcular total de la venta
  UPDATE ventas_pos SET
    subtotal = (SELECT COALESCE(SUM(subtotal), 0) FROM ventas_pos_items WHERE venta_id = v_venta_id AND estado != 'anulado'),
    total = (SELECT COALESCE(SUM(subtotal), 0) FROM ventas_pos_items WHERE venta_id = v_venta_id AND estado != 'anulado') - descuento_total + propina,
    updated_at = NOW()
  WHERE id = v_venta_id;

  -- Audit override
  INSERT INTO ventas_pos_overrides (
    tenant_id, venta_id, item_id, tipo, manager_id, motivo, payload, created_at
  ) VALUES (
    auth_tenant_id(), v_venta_id, p_item_id, 'modificar_precio_item', p_manager_id, p_motivo,
    jsonb_build_object('precio_anterior', v_precio_actual, 'precio_nuevo', p_nuevo_precio, 'cantidad', v_cantidad),
    NOW()
  );

  -- Marcar idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, created_at)
    VALUES ('fn_modificar_precio_item_comanda', p_idempotency_key, NOW())
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
  v_venta_id INTEGER;
  v_local_id INTEGER;
  v_precio_actual NUMERIC;
  v_estado TEXT;
  v_existing INTEGER;
BEGIN
  IF auth_tenant_id() IS NULL THEN RAISE EXCEPTION 'SIN_TENANT'; END IF;
  IF length(coalesce(p_motivo, '')) < 5 THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM idempotency_keys
     WHERE rpc_name = 'fn_cortesia_item_comanda' AND key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT vpi.venta_id, vpi.precio_unitario, vpi.estado, v.local_id
    INTO v_venta_id, v_precio_actual, v_estado, v_local_id
    FROM ventas_pos_items vpi
    JOIN ventas_pos v ON v.id = vpi.venta_id
   WHERE vpi.id = p_item_id
   FOR UPDATE;

  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_EXISTE'; END IF;
  IF v_estado = 'anulado' THEN RAISE EXCEPTION 'ITEM_ANULADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  PERFORM 1 FROM rrhh_empleados WHERE id = p_manager_id::TEXT AND activo = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGER_NO_VALIDO'; END IF;

  -- Marca como cortesía: precio 0, flag true, guarda precio original
  UPDATE ventas_pos_items SET
    precio_unitario_original = COALESCE(precio_unitario_original, v_precio_actual),
    precio_unitario = 0,
    subtotal = 0,
    es_cortesia = TRUE,
    updated_at = NOW()
  WHERE id = p_item_id;

  UPDATE ventas_pos SET
    subtotal = (SELECT COALESCE(SUM(subtotal), 0) FROM ventas_pos_items WHERE venta_id = v_venta_id AND estado != 'anulado'),
    total = (SELECT COALESCE(SUM(subtotal), 0) FROM ventas_pos_items WHERE venta_id = v_venta_id AND estado != 'anulado') - descuento_total + propina,
    updated_at = NOW()
  WHERE id = v_venta_id;

  INSERT INTO ventas_pos_overrides (
    tenant_id, venta_id, item_id, tipo, manager_id, motivo, payload, created_at
  ) VALUES (
    auth_tenant_id(), v_venta_id, p_item_id, 'cortesia_item', p_manager_id, p_motivo,
    jsonb_build_object('precio_regalado', v_precio_actual),
    NOW()
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, created_at)
    VALUES ('fn_cortesia_item_comanda', p_idempotency_key, NOW())
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cortesia_item_comanda(INTEGER, UUID, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
