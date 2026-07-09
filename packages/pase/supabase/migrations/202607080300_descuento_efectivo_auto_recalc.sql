-- 202607080300 · Descuento efectivo con auto-recalc al agregar items
--
-- Lucas 2026-07-08: cuando se aplica el 10% efectivo y después se agregan
-- más items, el descuento tiene que actualizarse automáticamente para
-- cubrir todo el subtotal (no solo el que había al momento de aplicar).
--
-- Solución: guardar el % en la venta y recomputar descuento_total cada vez
-- que se recalcula el total (dispara al agregar/anular items). El descuento
-- manual (dialog "Aplicar descuento") desactiva el % automático.

-- ─── 1. Columna descuento_efectivo_pct ─────────────────────────────────────
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS descuento_efectivo_pct numeric(5,2) NULL;

COMMENT ON COLUMN ventas_pos.descuento_efectivo_pct IS
  '% del descuento efectivo activo. NULL = sin descuento efectivo. El descuento_total se recomputa desde este % cuando cambian los items.';

-- ─── 2. fn_recalc_total_venta con auto-recalc del descuento ────────────────
CREATE OR REPLACE FUNCTION fn_recalc_total_venta(p_venta_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_propina NUMERIC;
  v_total NUMERIC;
  v_descuento_pct NUMERIC;
BEGIN
  SELECT COALESCE(SUM(subtotal - descuento), 0) INTO v_subtotal
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';

  SELECT COALESCE(descuento_total, 0), COALESCE(propina, 0), descuento_efectivo_pct
    INTO v_descuento, v_propina, v_descuento_pct
    FROM ventas_pos
   WHERE id = p_venta_id;

  -- Si el descuento efectivo está activo, lo recomputamos desde el pct.
  -- Sobrescribe el descuento_total (el dialog manual limpia el pct).
  IF v_descuento_pct IS NOT NULL AND v_descuento_pct > 0 THEN
    v_descuento := ROUND(v_subtotal * v_descuento_pct / 100, 2);
  END IF;

  v_total := GREATEST(0, v_subtotal - v_descuento + v_propina);

  UPDATE ventas_pos SET
    subtotal = v_subtotal,
    descuento_total = v_descuento,
    total = v_total,
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$$;

-- ─── 3. Aplicar descuento efectivo ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_aplicar_descuento_efectivo(p_venta_id bigint, p_pct numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
    RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
  END IF;
  IF p_pct IS NULL OR p_pct <= 0 OR p_pct > 100 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: pct fuera de rango (0-100)';
  END IF;

  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos SET
    descuento_efectivo_pct = p_pct, updated_at = NOW()
  WHERE id = p_venta_id;

  PERFORM fn_recalc_total_venta(p_venta_id);
END;
$$;

-- ─── 4. Quitar descuento efectivo ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_quitar_descuento_efectivo(p_venta_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
BEGIN
  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos SET
    descuento_efectivo_pct = NULL,
    descuento_total = 0,
    updated_at = NOW()
  WHERE id = p_venta_id;

  PERFORM fn_recalc_total_venta(p_venta_id);
END;
$$;

-- ─── 5. fn_aplicar_descuento_comanda limpia el pct automático ──────────────
-- Reemplaza la versión anterior — mismo body salvo el clear de pct + el
-- IF descuento manual sobrescribe el pct.
CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda(
  p_venta_id bigint,
  p_monto numeric,
  p_motivo text DEFAULT NULL,
  p_manager_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subtotal NUMERIC;
  v_propina NUMERIC;
  v_local_id INTEGER;
  v_cajero UUID;
  v_pct NUMERIC;
  v_anterior NUMERIC;
  v_max_descuento NUMERIC;
  v_existing BIGINT;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT subtotal, COALESCE(propina, 0), local_id, cajero_id, descuento_total
    INTO v_subtotal, v_propina, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF p_manager_id IS NOT NULL THEN
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;

  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el monto debe ser >= 0';
  END IF;
  v_max_descuento := v_subtotal + v_propina;
  IF p_monto > v_max_descuento THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el descuento (%) supera el subtotal+propina (%)',
      p_monto, v_max_descuento;
  END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  IF v_pct > 15 THEN
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO_DESCUENTO_GRANDE'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
    ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;
  ELSE
    IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
    END IF;
  END IF;

  -- Descuento manual limpia el pct automático (se vuelve fijo).
  UPDATE ventas_pos SET
    descuento_total = p_monto,
    descuento_efectivo_pct = NULL,
    updated_at = NOW()
  WHERE id = p_venta_id;
  PERFORM fn_recalc_total_venta(p_venta_id);

  IF p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
      valor_anterior, valor_nuevo, monto_afectado, idempotency_key
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
      p_manager_id, 'discount', p_motivo, v_anterior, p_monto, p_monto,
      p_idempotency_key
    );
  END IF;
END;
$$;
