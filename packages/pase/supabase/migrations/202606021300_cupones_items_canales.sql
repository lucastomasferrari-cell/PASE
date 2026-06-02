-- 202606021300_cupones_items_canales.sql
-- Brainstorm #8 Fase 5 Chunk B — Cupones por items + canales.
--
-- Pedido viejo de Lucas: limitar cupones a items específicos (ej. NEKO20
-- solo aplica a sushi rolls, no a bebidas) y a canales específicos
-- (ej. RAPPI10 solo en Rappi, no en tienda propia).
--
-- Cambios:
--   1. ALTER cupones: items_aplicables_ids BIGINT[] + canales_aplicables TEXT[].
--      NULL en ambos = aplica a TODOS (back-compat con cupones existentes).
--   2. CREATE OR REPLACE fn_validar_cupon con 2 params opcionales nuevos
--      (p_items_ids + p_canal). Si el cupón tiene items_aplicables_ids y
--      el carrito no incluye ninguno → motivo='ITEMS_NO_APLICAN'. Si el
--      cupón tiene canales_aplicables y el canal del pedido no está →
--      motivo='CANAL_NO_APLICA'.
--   3. fn_aplicar_cupon ya delega a fn_validar_cupon — no cambia signature.

-- ─── 1. Columnas nuevas ─────────────────────────────────────────────────────
ALTER TABLE cupones
  ADD COLUMN IF NOT EXISTS items_aplicables_ids BIGINT[] NULL,
  ADD COLUMN IF NOT EXISTS canales_aplicables TEXT[] NULL;

COMMENT ON COLUMN cupones.items_aplicables_ids IS
  'BIGINT[] de items.id donde aplica el cupón. NULL = todos los items. F5 Chunk B.';
COMMENT ON COLUMN cupones.canales_aplicables IS
  'TEXT[] de canales donde aplica (tienda_online, marketplace, pos, whatsapp, rappi, pedidosya). NULL = todos. F5 Chunk B.';

-- Index para queries que filtran por algún canal/item dentro del array
CREATE INDEX IF NOT EXISTS idx_cupones_canales_aplicables
  ON cupones USING GIN (canales_aplicables) WHERE canales_aplicables IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cupones_items_aplicables
  ON cupones USING GIN (items_aplicables_ids) WHERE items_aplicables_ids IS NOT NULL;

-- ─── 2. Modificar fn_validar_cupon ──────────────────────────────────────────
-- DROP requerido porque agregamos params al medio de la firma original.
-- (Podríamos agregar al final, pero quedaría feo el orden — preferimos limpio.)
DROP FUNCTION IF EXISTS fn_validar_cupon(TEXT, TEXT, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION fn_validar_cupon(
  p_local_slug TEXT,
  p_code TEXT,
  p_monto_compra NUMERIC,
  p_cliente_telefono TEXT DEFAULT NULL,
  p_items_ids BIGINT[] DEFAULT NULL,
  p_canal TEXT DEFAULT NULL
) RETURNS TABLE (
  valido BOOLEAN,
  motivo TEXT,
  descuento NUMERIC,
  cupon_id BIGINT
) LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_cupon RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_usos_cliente INTEGER;
  v_descuento NUMERIC;
BEGIN
  SELECT cls.local_id, l.tenant_id INTO v_local_id, v_tenant_id
    FROM comanda_local_settings cls
    INNER JOIN locales l ON l.id = cls.local_id
   WHERE cls.slug = p_local_slug AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'LOCAL_NO_ENCONTRADO'::TEXT, 0::NUMERIC, NULL::BIGINT; RETURN;
  END IF;

  SELECT * INTO v_cupon FROM cupones
   WHERE tenant_id = v_tenant_id
     AND UPPER(code) = UPPER(trim(p_code))
     AND deleted_at IS NULL
     AND activo = TRUE
     AND (local_id IS NULL OR local_id = v_local_id)
   ORDER BY local_id NULLS LAST
   LIMIT 1;

  IF v_cupon.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'CUPON_INVALIDO'::TEXT, 0::NUMERIC, NULL::BIGINT; RETURN;
  END IF;

  IF v_cupon.fecha_desde IS NOT NULL AND v_now < v_cupon.fecha_desde THEN
    RETURN QUERY SELECT FALSE, 'CUPON_NO_VIGENTE_AUN'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;
  IF v_cupon.fecha_hasta IS NOT NULL AND v_now > v_cupon.fecha_hasta THEN
    RETURN QUERY SELECT FALSE, 'CUPON_VENCIDO'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;

  IF v_cupon.monto_min_compra IS NOT NULL AND p_monto_compra < v_cupon.monto_min_compra THEN
    RETURN QUERY SELECT FALSE, 'MONTO_MIN_NO_ALCANZADO'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;

  IF v_cupon.max_usos IS NOT NULL AND v_cupon.usos_actuales >= v_cupon.max_usos THEN
    RETURN QUERY SELECT FALSE, 'CUPON_AGOTADO'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;

  IF v_cupon.max_usos_por_cliente IS NOT NULL AND p_cliente_telefono IS NOT NULL THEN
    SELECT COUNT(*) INTO v_usos_cliente FROM cupon_usos
     WHERE cupon_id = v_cupon.id AND cliente_telefono = p_cliente_telefono;
    IF v_usos_cliente >= v_cupon.max_usos_por_cliente THEN
      RETURN QUERY SELECT FALSE, 'YA_USASTE_ESTE_CUPON'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
  END IF;

  IF v_cupon.solo_primera_compra AND p_cliente_telefono IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM ventas_pos v
      WHERE v.tenant_id = v_tenant_id
        AND v.cliente_telefono = p_cliente_telefono
        AND v.estado = 'cobrada'
        AND v.deleted_at IS NULL
    ) THEN
      RETURN QUERY SELECT FALSE, 'SOLO_PRIMERA_COMPRA'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
  END IF;

  -- NUEVO F5 Chunk B: filtro por canal
  -- Si el cupón restringe canales y el canal del pedido no está → rechazo
  IF v_cupon.canales_aplicables IS NOT NULL AND array_length(v_cupon.canales_aplicables, 1) > 0 THEN
    IF p_canal IS NULL OR NOT (p_canal = ANY(v_cupon.canales_aplicables)) THEN
      RETURN QUERY SELECT FALSE, 'CANAL_NO_APLICA'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
  END IF;

  -- NUEVO F5 Chunk B: filtro por items aplicables
  -- Si el cupón restringe items y el carrito no contiene ninguno → rechazo
  IF v_cupon.items_aplicables_ids IS NOT NULL AND array_length(v_cupon.items_aplicables_ids, 1) > 0 THEN
    IF p_items_ids IS NULL OR array_length(p_items_ids, 1) IS NULL THEN
      RETURN QUERY SELECT FALSE, 'ITEMS_NO_APLICAN'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
    -- Overlap: al menos un item del carrito debe estar en items_aplicables
    IF NOT (p_items_ids && v_cupon.items_aplicables_ids) THEN
      RETURN QUERY SELECT FALSE, 'ITEMS_NO_APLICAN'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
  END IF;

  -- Calcular descuento
  IF v_cupon.tipo = 'porcentaje' THEN
    v_descuento := p_monto_compra * (v_cupon.valor / 100.0);
  ELSE
    v_descuento := v_cupon.valor;
  END IF;
  IF v_cupon.cap_descuento IS NOT NULL AND v_descuento > v_cupon.cap_descuento THEN
    v_descuento := v_cupon.cap_descuento;
  END IF;
  IF v_descuento > p_monto_compra THEN
    v_descuento := p_monto_compra;
  END IF;

  RETURN QUERY SELECT TRUE, 'OK'::TEXT, v_descuento, v_cupon.id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_validar_cupon(TEXT, TEXT, NUMERIC, TEXT, BIGINT[], TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
