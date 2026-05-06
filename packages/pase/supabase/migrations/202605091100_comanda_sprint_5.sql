-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 5 — Tienda online estética V2
--
-- Cambios:
--   1. items.destacado_tienda BOOLEAN — para fallback manual a "Popular".
--   2. fn_get_populares_tienda_comanda RPC — top items por ventas reales,
--      consumido por la sección "Popular" del rediseño Tienda online.
--
-- Diseño:
--   - El RPC mira ventas_pos_items de los últimos N días (default 30) para
--     un local determinado por p_local_slug. Filtra por estado != 'anulado'
--     y ventas cobradas. Limit configurable (default 8).
--   - Si NO hay suficientes ventas históricas, el frontend hace fallback
--     a items con destacado_tienda=TRUE (filtro local en el cliente, no
--     repite query). Si igual no alcanzan, oculta la sección.
--   - SECURITY DEFINER + GRANT TO anon: la tienda online es pública, sin
--     auth. RLS no se aplica adentro del RPC.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. items.destacado_tienda ──────────────────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS destacado_tienda BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN items.destacado_tienda IS
  'Marcar manualmente para que aparezca en la sección Popular de la tienda online cuando no hay suficientes ventas históricas para llenarla. Default false.';

-- ─── 2. fn_get_populares_tienda_comanda ────────────────────────────────
-- Top N items más vendidos en los últimos X días, para sección Popular
-- de la tienda online. Devuelve también precio del canal tienda-propia
-- y datos del grupo (color_ramp) para que el frontend pinte la card.
CREATE OR REPLACE FUNCTION fn_get_populares_tienda_comanda(
  p_local_slug TEXT,
  p_dias INTEGER DEFAULT 30,
  p_limit INTEGER DEFAULT 8
) RETURNS TABLE (
  item_id INTEGER,
  nombre TEXT,
  descripcion TEXT,
  emoji TEXT,
  foto_url TEXT,
  precio_canal NUMERIC,
  grupo_id INTEGER,
  grupo_nombre TEXT,
  grupo_color_ramp TEXT,
  cantidad_vendida NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
  v_canal_id INTEGER;
BEGIN
  -- Obtener local desde slug
  SELECT cls.local_id INTO v_local_id
  FROM comanda_local_settings cls
  WHERE cls.slug = p_local_slug;

  IF v_local_id IS NULL THEN RETURN; END IF;

  -- Obtener canal tienda-propia del tenant del local
  SELECT c.id INTO v_canal_id
  FROM canales c
  INNER JOIN locales l ON l.tenant_id = c.tenant_id
  WHERE c.slug = 'tienda-propia'
    AND c.activo = TRUE
    AND l.id = v_local_id
  LIMIT 1;

  IF v_canal_id IS NULL THEN RETURN; END IF;

  -- Top items por cantidad vendida en el período
  RETURN QUERY
    SELECT
      i.id,
      i.nombre,
      i.descripcion,
      i.emoji,
      i.foto_url,
      ipc.precio,
      g.id,
      g.nombre,
      g.color_ramp,
      COALESCE(SUM(vpi.cantidad), 0)::NUMERIC AS cantidad_vendida
    FROM items i
    INNER JOIN item_precios_canal ipc
      ON ipc.item_id = i.id AND ipc.canal_id = v_canal_id
    LEFT JOIN item_grupos g ON i.grupo_id = g.id
    LEFT JOIN ventas_pos_items vpi
      ON vpi.item_id = i.id
     AND vpi.estado != 'anulado'
     AND vpi.deleted_at IS NULL
    LEFT JOIN ventas_pos vp
      ON vpi.venta_id = vp.id
     AND vp.local_id = v_local_id
     AND vp.estado = 'cobrada'
     AND vp.cobrada_at > NOW() - (p_dias || ' days')::INTERVAL
    WHERE i.deleted_at IS NULL
      AND i.estado = 'disponible'
      AND i.visible_tienda = TRUE
      AND ipc.vendible = TRUE
      AND ipc.deleted_at IS NULL
    GROUP BY i.id, i.nombre, i.descripcion, i.emoji, i.foto_url, ipc.precio, g.id, g.nombre, g.color_ramp
    ORDER BY cantidad_vendida DESC, i.nombre ASC
    LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_get_populares_tienda_comanda(TEXT, INTEGER, INTEGER) TO anon;
GRANT EXECUTE ON FUNCTION fn_get_populares_tienda_comanda(TEXT, INTEGER, INTEGER) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN COMANDA Sprint 5
-- ═══════════════════════════════════════════════════════════════════════════
