-- ─── COMANDA: fixes varios + editor inline de items ───────────────────────
-- 1. fn_toggle_favorito_pos: rrhh_empleados no tiene updated_at — se saca
-- 2. ventas_pos_items: columna nombre_display para override del nombre en ticket
-- 3. fn_modificar_item_comanda: acepta p_nombre_display y p_precio_unitario

-- ─── 1. Fix fn_toggle_favorito_pos (updated_at inexistente) ──────────────
CREATE OR REPLACE FUNCTION fn_toggle_favorito_pos(
  p_empleado_id UUID,
  p_item_id INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actuales JSONB;
  v_nuevos JSONB;
  v_tiene BOOLEAN;
BEGIN
  IF auth_tenant_id() IS NULL THEN RAISE EXCEPTION 'SIN_TENANT'; END IF;

  SELECT pos_favoritos INTO v_actuales FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_actuales IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_EXISTE'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_actuales) AS e
    WHERE e::INTEGER = p_item_id
  ) INTO v_tiene;

  IF v_tiene THEN
    v_nuevos := (
      SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
      FROM jsonb_array_elements(v_actuales) AS e
      WHERE e::INTEGER != p_item_id
    );
  ELSE
    IF jsonb_array_length(v_actuales) >= 20 THEN
      RAISE EXCEPTION 'MAX_FAVORITOS_EXCEDIDO';
    END IF;
    v_nuevos := v_actuales || to_jsonb(p_item_id);
  END IF;

  -- ← updated_at removido: la columna no existe en rrhh_empleados
  UPDATE rrhh_empleados SET pos_favoritos = v_nuevos WHERE id = p_empleado_id;
  RETURN v_nuevos;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_toggle_favorito_pos(UUID, INTEGER) TO authenticated;

-- ─── 2. nombre_display en ventas_pos_items ────────────────────────────────
-- Permite que el mozo cambie el nombre visible del ítem en la cuenta / ticket
-- sin afectar el catálogo. NULL = usa el nombre del catálogo (default).
ALTER TABLE ventas_pos_items ADD COLUMN IF NOT EXISTS nombre_display TEXT NULL;

-- ─── 3. fn_modificar_item_comanda — agrega nombre_display y precio_unitario
-- Necesita DROP + CREATE porque cambia la firma (más parámetros).
DROP FUNCTION IF EXISTS fn_modificar_item_comanda(BIGINT, NUMERIC, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION fn_modificar_item_comanda(
  p_item_id      BIGINT,
  p_cantidad     NUMERIC DEFAULT NULL,
  p_curso        INTEGER DEFAULT NULL,
  p_notas        TEXT    DEFAULT NULL,
  p_nombre_display TEXT  DEFAULT NULL,
  p_precio_unitario NUMERIC DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_pu       NUMERIC;
  v_qty      NUMERIC;
  v_estado   TEXT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT venta_id, local_id, precio_unitario, cantidad, estado
    INTO v_venta_id, v_local_id, v_pu, v_qty, v_estado
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado IN ('enviado','listo','entregado','anulado') THEN
    RAISE EXCEPTION 'ITEM_NO_EDITABLE: estado %', v_estado;
  END IF;

  -- Precio y cantidad efectivos tras el update
  DECLARE
    v_precio_nuevo NUMERIC := COALESCE(p_precio_unitario, v_pu);
    v_qty_nuevo    NUMERIC := COALESCE(p_cantidad, v_qty);
  BEGIN
    UPDATE ventas_pos_items SET
      cantidad        = v_qty_nuevo,
      precio_unitario = v_precio_nuevo,
      subtotal        = v_qty_nuevo * v_precio_nuevo,
      curso           = COALESCE(p_curso, curso),
      notas           = COALESCE(p_notas, notas),
      nombre_display  = COALESCE(p_nombre_display, nombre_display),
      updated_at      = NOW()
    WHERE id = p_item_id;
  END;

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_modificar_item_comanda(BIGINT, NUMERIC, INTEGER, TEXT, TEXT, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';
