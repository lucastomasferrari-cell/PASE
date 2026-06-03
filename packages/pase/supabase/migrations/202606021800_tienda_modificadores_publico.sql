-- 202606021800_tienda_modificadores_publico.sql
-- Brainstorm #8 Fase 6 — Chunk Item Detalle + Modificadores en Tienda pública.
--
-- Hoy `v_catalogo_publico` expone el catálogo pero NO indica si un item
-- tiene modificadores (size, extras, sin/con). El frontend de tienda
-- agregaba +1 directo al carrito sin pedirlos → bloqueante para
-- sushi/burgers/pizzas con customización.
--
-- Esta migration:
--   1. Recrea v_catalogo_publico con flag `tiene_modificadores` BOOLEAN
--      (EXISTS subquery — costo casi nulo, pgcatalog usa los índices).
--   2. Crea RPC `fn_get_modificadores_publico(p_item_id, p_local_slug)`
--      SECURITY DEFINER expuesta a anon, que devuelve los modifier_groups
--      asignados al item con sus modifiers activos. Valida que el item
--      esté en la vista pública del slug — anti-enumeration.
--
-- NO toca tablas, NO requiere backfill. Vista + RPC nuevas.

-- ─── 1. Vista v_catalogo_publico extendida ─────────────────────────────────
DROP VIEW IF EXISTS v_catalogo_publico;
CREATE VIEW v_catalogo_publico AS
SELECT i.id AS item_id,
       i.nombre,
       i.descripcion,
       i.emoji,
       i.foto_url,
       ipc.precio AS precio,
       ipc.canal_id,
       g.id AS grupo_id,
       g.nombre AS grupo_nombre,
       g.emoji AS grupo_emoji,
       g.color_ramp AS grupo_color_ramp,
       cls.local_id,
       cls.slug AS local_slug,
       EXISTS (
         SELECT 1
           FROM item_modifier_groups img
           JOIN modifier_groups mg ON mg.id = img.modifier_group_id
                                  AND mg.deleted_at IS NULL
          WHERE img.item_id = i.id
       ) AS tiene_modificadores
  FROM items i
  LEFT JOIN item_grupos g ON i.grupo_id = g.id AND g.deleted_at IS NULL
  INNER JOIN item_precios_canal ipc
    ON ipc.item_id = i.id AND ipc.deleted_at IS NULL AND ipc.vendible = TRUE
  INNER JOIN canales c
    ON ipc.canal_id = c.id AND c.deleted_at IS NULL AND c.activo = TRUE
       AND c.slug = 'tienda-propia'
  INNER JOIN comanda_local_settings cls
    ON cls.tenant_id = i.tenant_id
       AND (c.local_id IS NULL OR c.local_id = cls.local_id)
       AND cls.tienda_activa = TRUE
       AND cls.deleted_at IS NULL
 WHERE i.deleted_at IS NULL
   AND i.estado = 'disponible'
   AND i.visible_tienda = TRUE;

GRANT SELECT ON v_catalogo_publico TO anon;
GRANT SELECT ON v_catalogo_publico TO authenticated;

COMMENT ON VIEW v_catalogo_publico IS
  'Catálogo público de tienda online. Filtra por canal tienda-propia, ' ||
  'item disponible+visible, local tienda_activa. Columna tiene_modificadores ' ||
  'permite al frontend decidir entre +1 directo o abrir pantalla detalle.';

-- ─── 2. RPC pública para obtener modificadores de un item ──────────────────
-- Validación: el item debe estar en la vista pública del slug. Sin esto,
-- un atacante podría enumerar modifier_groups con item_id arbitrario.
CREATE OR REPLACE FUNCTION fn_get_modificadores_publico(
  p_item_id    INTEGER,
  p_local_slug TEXT
)
RETURNS TABLE (
  modifier_group_id  INTEGER,
  group_nombre       TEXT,
  group_descripcion  TEXT,
  group_tipo         TEXT,
  requerido          BOOLEAN,
  min_seleccion      INTEGER,
  max_seleccion      INTEGER,
  group_orden        INTEGER,
  modifier_id        INTEGER,
  modifier_nombre    TEXT,
  modifier_precio_extra NUMERIC,
  modifier_orden     INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existe BOOLEAN;
BEGIN
  -- Anti-enumeration: el item debe ser visible en la tienda de ese slug.
  SELECT EXISTS (
    SELECT 1 FROM v_catalogo_publico
     WHERE item_id = p_item_id AND local_slug = p_local_slug
  ) INTO v_existe;

  IF NOT v_existe THEN
    RETURN; -- empty set; el frontend interpreta como "no hay modifs"
  END IF;

  RETURN QUERY
  SELECT
    mg.id,
    mg.nombre,
    mg.descripcion,
    mg.tipo,
    COALESCE(img.requerido_override, mg.requerido),
    COALESCE(img.min_seleccion_override, mg.min_seleccion),
    COALESCE(img.max_seleccion_override, mg.max_seleccion),
    img.orden,
    m.id,
    m.nombre,
    m.precio_extra,
    m.orden
  FROM item_modifier_groups img
  JOIN modifier_groups mg ON mg.id = img.modifier_group_id
                         AND mg.deleted_at IS NULL
  LEFT JOIN modifiers m ON m.modifier_group_id = mg.id
                       AND m.deleted_at IS NULL
                       AND m.activo = TRUE
  WHERE img.item_id = p_item_id
  ORDER BY img.orden ASC, mg.id ASC, m.orden ASC, m.id ASC;
END;
$$;

REVOKE ALL ON FUNCTION fn_get_modificadores_publico(INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_get_modificadores_publico(INTEGER, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION fn_get_modificadores_publico(INTEGER, TEXT) IS
  'Tienda pública: lista modifier_groups + modifiers del item. Valida que ' ||
  'el item sea visible en la tienda del slug. Retorna empty si no es válido ' ||
  '(no informa si el item existe o no — anti-enumeration).';

NOTIFY pgrst, 'reload schema';
