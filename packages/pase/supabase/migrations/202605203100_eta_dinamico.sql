-- ═══════════════════════════════════════════════════════════════════════════
-- ETA dinámico
--
-- Calcula el tiempo estimado de preparación + delivery basándose en:
--   - tiempo_base configurado en comanda_local_settings
--   - cola actual de pedidos activos (necesita_aprobacion + enviada + lista)
--   - incremento configurable por pedido en cola
--
-- Fórmula simple:
--   eta_min = tiempo_base_min + (pedidos_en_cola * incremento_por_pedido_min)
--
-- Se llama desde:
--   - TiendaCheckout (al armar el pedido — muestra al cliente cuánto va a tardar)
--   - fn_crear_pedido_publico_comanda guarda el ETA al momento de crear el pedido
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS eta_incremento_por_pedido_min INTEGER DEFAULT 3;

COMMENT ON COLUMN comanda_local_settings.eta_incremento_por_pedido_min IS
  'Minutos extra por cada pedido en cola al estimar ETA dinámico. Default 3min.';

-- Calcula el ETA en minutos para un local. Public — se puede consultar
-- desde tienda online sin login.
CREATE OR REPLACE FUNCTION fn_calcular_eta_local(
  p_local_slug TEXT,
  p_tipo_entrega TEXT
) RETURNS TABLE (
  eta_minutos INTEGER,
  tiempo_base INTEGER,
  pedidos_en_cola INTEGER,
  incremento_por_pedido INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_local_id INTEGER;
  v_tiempo_base INTEGER;
  v_incremento INTEGER;
  v_cola INTEGER;
  v_eta INTEGER;
BEGIN
  SELECT cls.local_id,
         CASE WHEN p_tipo_entrega = 'delivery'
              THEN cls.tiempo_delivery_min
              ELSE cls.tiempo_retiro_min
         END,
         COALESCE(cls.eta_incremento_por_pedido_min, 3)
    INTO v_local_id, v_tiempo_base, v_incremento
    FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug
     AND cls.tienda_activa = TRUE
     AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  -- Cola actual: pedidos no entregados ni cancelados
  SELECT COUNT(*) INTO v_cola
    FROM ventas_pos
   WHERE local_id = v_local_id
     AND estado IN ('necesita_aprobacion', 'enviada', 'lista')
     AND deleted_at IS NULL;

  v_eta := v_tiempo_base + (v_cola * v_incremento);

  RETURN QUERY SELECT v_eta, v_tiempo_base, v_cola, v_incremento;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_calcular_eta_local(TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_calcular_eta_local(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
