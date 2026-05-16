-- ─── Geocoding de pedidos: lat/lon del cliente ──────────────────────────────
-- Agrega columnas lat/lon a ventas_pos para guardar la geolocalización
-- exacta de la dirección de entrega. Útil para:
--   - Mostrar mini-mapa al cajero en PedidoDetalle
--   - Calcular distancia local↔cliente (radio de delivery)
--   - Futuro: rutas para repartidores
--
-- El cliente popula estos campos via fn_set_pedido_geo después de crear
-- el pedido (separado de fn_crear_pedido_publico_comanda para no tocar
-- una RPC crítica que ya funciona).

ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS cliente_lat NUMERIC(10,7) NULL;
ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS cliente_lon NUMERIC(10,7) NULL;

COMMENT ON COLUMN ventas_pos.cliente_lat IS 'Latitud de la dirección de entrega. Llenado por geocoding cliente-side (Google).';
COMMENT ON COLUMN ventas_pos.cliente_lon IS 'Longitud de la dirección de entrega.';

-- RPC pública para que el frontend público (tienda online) pueda asociar
-- lat/lon a una venta recién creada. Solo permite escribir si la venta
-- está en estado 'necesita_aprobacion' (no editado después).
CREATE OR REPLACE FUNCTION fn_set_pedido_geo(
  p_venta_id BIGINT,
  p_lat NUMERIC,
  p_lon NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado TEXT;
BEGIN
  -- Validaciones rango lat/lon
  IF p_lat IS NULL OR p_lon IS NULL THEN RAISE EXCEPTION 'LATLON_NULL'; END IF;
  IF p_lat < -90 OR p_lat > 90 THEN RAISE EXCEPTION 'LAT_INVALIDA'; END IF;
  IF p_lon < -180 OR p_lon > 180 THEN RAISE EXCEPTION 'LON_INVALIDA'; END IF;

  -- Solo escribir si la venta existe y está pendiente de aprobación
  -- (defensa contra abuso del endpoint público — no se edita venta en curso).
  SELECT estado INTO v_estado FROM ventas_pos WHERE id = p_venta_id;
  IF v_estado IS NULL THEN RAISE EXCEPTION 'VENTA_NO_EXISTE'; END IF;
  IF v_estado != 'necesita_aprobacion' THEN
    -- Silente: ya está aprobada, no modificamos. No es error fatal.
    RETURN;
  END IF;

  UPDATE ventas_pos
     SET cliente_lat = p_lat,
         cliente_lon = p_lon,
         updated_at = NOW()
   WHERE id = p_venta_id AND estado = 'necesita_aprobacion';
END;
$$;

GRANT EXECUTE ON FUNCTION fn_set_pedido_geo(BIGINT, NUMERIC, NUMERIC) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
