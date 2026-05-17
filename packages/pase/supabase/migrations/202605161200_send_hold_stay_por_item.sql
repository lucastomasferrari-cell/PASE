-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 2 competitor F #1 — Send / Hold / Stay por item individual
--
-- Hoy "mandar curso N" envía TODOS los items en hold de ese curso. Toast/
-- TouchBistro permiten más granular:
--   - Send individual: este item se va a cocina YA, aunque el resto del
--     curso siga en hold (típico para entrada para compartir o bebida).
--   - Hold: estado natural, ya existe.
--   - Stay: el item se queda en hold permanentemente; "mandar curso" lo
--     skipea. Solo sale cuando el mozo lo libera manualmente. Caso típico:
--     postre del curso 1 que querés que salga al final.
--
-- Cambios:
--   1. ALTER ventas_pos_items ADD stay_until_release BOOLEAN DEFAULT FALSE.
--   2. fn_mandar_curso_comanda: WHERE incluye AND stay_until_release = FALSE.
--   3. RPC fn_mandar_item_individual_comanda(p_item_id) para enviar uno.
--   4. RPC fn_toggle_item_stay_comanda(p_item_id) para activar/desactivar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Columna stay_until_release ─────────────────────────────────────────
ALTER TABLE ventas_pos_items
  ADD COLUMN IF NOT EXISTS stay_until_release BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ventas_pos_items.stay_until_release IS
  'Si TRUE, este item queda en hold aunque se mande el curso completo. Solo sale cuando se llama fn_mandar_item_individual_comanda. Sprint 2 F #1.';

-- ─── 2. fn_mandar_curso_comanda: skipear items con stay=TRUE ───────────────
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
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- Sprint 2 F #1: skipear items con stay_until_release=TRUE
  UPDATE ventas_pos_items SET
    estado = 'enviado', enviado_at = NOW(), updated_at = NOW()
  WHERE venta_id = p_venta_id AND curso = p_curso
    AND estado = 'hold'
    AND stay_until_release = FALSE
    AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Trigger coursing auto se dispara solo si hay alguno enviado.
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION fn_mandar_curso_comanda(BIGINT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mandar_curso_comanda(BIGINT, INTEGER) TO authenticated;

-- ─── 3. fn_mandar_item_individual_comanda ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_mandar_item_individual_comanda(
  p_item_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, estado INTO v_local_id, v_estado
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado != 'hold' THEN
    RAISE EXCEPTION 'ITEM_NO_EN_HOLD: estado actual %', v_estado;
  END IF;

  UPDATE ventas_pos_items SET
    estado = 'enviado',
    enviado_at = NOW(),
    -- al mandarlo individual, liberamos también el stay (ya cumplió su rol)
    stay_until_release = FALSE,
    updated_at = NOW()
  WHERE id = p_item_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_mandar_item_individual_comanda(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mandar_item_individual_comanda(BIGINT) TO authenticated;

-- ─── 4. fn_toggle_item_stay_comanda ────────────────────────────────────────
-- Toggle del flag. Solo aplicable a items en hold (no tiene sentido en items
-- ya enviados a cocina). Devuelve el nuevo valor del flag.
CREATE OR REPLACE FUNCTION fn_toggle_item_stay_comanda(
  p_item_id BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
  v_actual BOOLEAN;
  v_nuevo BOOLEAN;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, estado, stay_until_release INTO v_local_id, v_estado, v_actual
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado != 'hold' THEN
    RAISE EXCEPTION 'ITEM_NO_EN_HOLD: solo items en hold aceptan stay';
  END IF;

  v_nuevo := NOT COALESCE(v_actual, FALSE);
  UPDATE ventas_pos_items SET
    stay_until_release = v_nuevo,
    updated_at = NOW()
  WHERE id = p_item_id;

  RETURN v_nuevo;
END;
$$;

REVOKE ALL ON FUNCTION fn_toggle_item_stay_comanda(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_toggle_item_stay_comanda(BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
