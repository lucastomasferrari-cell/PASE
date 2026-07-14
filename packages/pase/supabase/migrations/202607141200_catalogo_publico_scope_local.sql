-- v_catalogo_publico: la vista matcheaba items a comanda_local_settings SOLO
-- por tenant, sin filtrar el local del item. Resultado: la tienda de un local
-- mostraba TODOS los items del tenant, incluidos los local-específicos de otros
-- locales (ej: los 53 items de Rene se colaban en la carta de Devoto).
-- Fix: scope del item al local (items globales local_id NULL + los del local).
CREATE OR REPLACE VIEW v_catalogo_publico AS
 SELECT i.id AS item_id,
    i.nombre,
    i.descripcion,
    i.emoji,
    i.foto_url,
    ipc.precio,
    ipc.canal_id,
    g.id AS grupo_id,
    g.nombre AS grupo_nombre,
    g.emoji AS grupo_emoji,
    g.color_ramp AS grupo_color_ramp,
    cls.local_id,
    cls.slug AS local_slug,
    (EXISTS ( SELECT 1
           FROM item_modifier_groups img
             JOIN modifier_groups mg ON mg.id = img.modifier_group_id AND mg.deleted_at IS NULL
          WHERE img.item_id = i.id)) AS tiene_modificadores
   FROM items i
     LEFT JOIN item_grupos g ON i.grupo_id = g.id AND g.deleted_at IS NULL
     JOIN item_precios_canal ipc ON ipc.item_id = i.id AND ipc.deleted_at IS NULL AND ipc.vendible = true
     JOIN canales c ON ipc.canal_id = c.id AND c.deleted_at IS NULL AND c.activo = true AND c.slug = 'tienda-propia'::text
     JOIN comanda_local_settings cls ON cls.tenant_id = i.tenant_id AND (c.local_id IS NULL OR c.local_id = cls.local_id) AND cls.tienda_activa = true AND cls.deleted_at IS NULL
  WHERE i.deleted_at IS NULL
    AND i.estado = 'disponible'::text
    AND i.visible_tienda = true
    -- FIX 2026-07-14: item scoped al local (global o del propio local)
    AND (i.local_id IS NULL OR i.local_id = cls.local_id)
    -- y el precio del canal scoped al local (global o override del local)
    AND (ipc.local_id IS NULL OR ipc.local_id = cls.local_id);
