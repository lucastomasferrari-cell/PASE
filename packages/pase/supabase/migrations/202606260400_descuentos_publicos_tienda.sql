-- ═══════════════════════════════════════════════════════════════════════════
-- fn_descuentos_publicos_tienda — cupones activos visibles en tienda online
-- 26-jun-2026
--
-- Lo usa la home pública del marketplace (`packages/comanda/src/pages/Tienda/`)
-- para mostrar promociones activas que el cliente puede usar al ordenar.
--
-- Reglas:
--   - cupón activo (activo=TRUE, deleted_at NULL, dentro de fecha_desde/hasta)
--   - aplicable al canal 'tienda_online' (canales_aplicables contiene 'tienda_online')
--   - sin haber excedido max_usos
--   - perteneciente al local (local_id matchea o local_id NULL = todos los locales)
--
-- Devuelve datos mínimos seguros (NO max_usos_por_cliente NI usos_actuales
-- para no leakear info competitiva).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_descuentos_publicos_tienda(p_local_slug TEXT)
RETURNS TABLE (
  code TEXT,
  descripcion TEXT,
  tipo TEXT,
  valor NUMERIC,
  monto_min_compra NUMERIC,
  fecha_hasta TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
BEGIN
  SELECT cls.local_id INTO v_local_id
  FROM comanda_local_settings cls
  WHERE cls.slug = p_local_slug
    AND cls.tienda_activa = TRUE
    AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN
    RETURN; -- Local no encontrado o tienda inactiva
  END IF;

  RETURN QUERY
  SELECT c.code, c.descripcion, c.tipo, c.valor, c.monto_min_compra, c.fecha_hasta
  FROM cupones c
  WHERE c.activo = TRUE
    AND c.deleted_at IS NULL
    AND (c.local_id = v_local_id OR c.local_id IS NULL)
    AND (c.fecha_desde IS NULL OR c.fecha_desde <= NOW())
    AND (c.fecha_hasta IS NULL OR c.fecha_hasta >= NOW())
    AND (c.max_usos IS NULL OR c.usos_actuales < c.max_usos)
    AND (c.canales_aplicables IS NULL OR 'tienda_online' = ANY(c.canales_aplicables))
    -- No mostrar los de primera compra al público (son cuestión de "te lo mando")
    AND COALESCE(c.solo_primera_compra, FALSE) = FALSE
  ORDER BY
    CASE WHEN c.tipo = 'porcentaje' THEN c.valor ELSE 0 END DESC,
    CASE WHEN c.tipo = 'monto_fijo' THEN c.valor ELSE 0 END DESC
  LIMIT 10;
END;
$$;

REVOKE ALL ON FUNCTION fn_descuentos_publicos_tienda(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_descuentos_publicos_tienda(TEXT) TO anon, authenticated;
