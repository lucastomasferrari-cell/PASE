-- ═══════════════════════════════════════════════════════════════════════════
-- RPC pública para la PWA del rider — info por token
--
-- La PWA en /r/:token necesita saber: ¿quién soy? ¿tengo pedido asignado?
-- ¿dónde está el cliente? Sin login.
--
-- Devuelve el subset mínimo de v_riders_status que el rider necesita ver.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_get_rider_info_publica(p_rider_token TEXT)
RETURNS TABLE (
  id BIGINT,
  nombre TEXT,
  online BOOLEAN,
  current_venta_id BIGINT,
  pedido_numero INTEGER,
  pedido_cliente TEXT,
  pedido_telefono TEXT,
  pedido_lat NUMERIC,
  pedido_lon NUMERIC,
  pedido_direccion TEXT,
  pedido_total NUMERIC,
  pedido_estado TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_rider_id BIGINT;
BEGIN
  IF p_rider_token IS NULL OR length(p_rider_token) < 16 THEN
    RETURN; -- vacío, no exponer error específico
  END IF;

  SELECT r.id INTO v_rider_id FROM delivery_riders r
   WHERE r.rider_token = p_rider_token
     AND r.deleted_at IS NULL
     AND r.activo = TRUE;
  IF v_rider_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.nombre,
    r.online,
    r.current_venta_id,
    v.numero_local,
    v.cliente_nombre,
    v.cliente_telefono,
    v.cliente_lat,
    v.cliente_lon,
    v.cliente_direccion,
    v.total,
    v.estado
  FROM delivery_riders r
  LEFT JOIN ventas_pos v ON v.id = r.current_venta_id AND v.deleted_at IS NULL
  WHERE r.id = v_rider_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_get_rider_info_publica(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_get_rider_info_publica(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
