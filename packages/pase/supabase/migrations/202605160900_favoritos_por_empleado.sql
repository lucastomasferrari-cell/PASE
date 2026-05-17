-- ─── Favoritos personales por empleado (Quick Items) ───────────────────────
-- Sprint 16/05 — cada cajero/mozo arma su pantalla de los ~12 productos que
-- más usa. Patrón Toast Quick Items. Reduce taps en VentaScreen al 80% de
-- las operaciones.
--
-- Implementado como JSONB array de item_ids en rrhh_empleados — simple,
-- mantiene orden de display, sin tabla extra.

ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS pos_favoritos JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN rrhh_empleados.pos_favoritos IS 'Array de item_ids (INTEGER) que el empleado eligió como sus favoritos para Quick Items en VentaScreen. Orden importa (display order).';

-- RPC: agregar/quitar item de favoritos del empleado actual (PIN POS).
-- Usa el empleado activo de la sesión POS — el caller pasa empleado_id.
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

  -- Verificar si ya está
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_actuales) AS e
    WHERE e::INTEGER = p_item_id
  ) INTO v_tiene;

  IF v_tiene THEN
    -- Sacar
    v_nuevos := (
      SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
      FROM jsonb_array_elements(v_actuales) AS e
      WHERE e::INTEGER != p_item_id
    );
  ELSE
    -- Agregar al final (max 20 para no saturar UI)
    IF jsonb_array_length(v_actuales) >= 20 THEN
      RAISE EXCEPTION 'MAX_FAVORITOS_EXCEDIDO';
    END IF;
    v_nuevos := v_actuales || to_jsonb(p_item_id);
  END IF;

  UPDATE rrhh_empleados SET pos_favoritos = v_nuevos, updated_at = NOW() WHERE id = p_empleado_id;
  RETURN v_nuevos;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_toggle_favorito_pos(UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
