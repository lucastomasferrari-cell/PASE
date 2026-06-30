-- ============================================================
-- Multi-marca · Fase 2: menú por marca.
-- marca_id en items / item_grupos / modifier_groups.
--   marca_id NULL = compartido entre TODAS las marcas del tenant.
--   marca_id = X  = exclusivo de la marca X.
-- Aditivo. Backfill: el menú actual es de Neko → marca Neko.
-- NO toca canales / item_precios_canal / estado(agotado) / ventas / CMV.
--
-- ⚠️ PENDIENTE (cuando se cargue el menú de una 2ª marca con nombres que
-- repiten): actualizar el UNIQUE de items/grupos para incluir marca_id, ej:
--   UNIQUE (tenant_id, COALESCE(marca_id,0), COALESCE(local_id,0), LOWER(nombre))
-- Hoy no hace falta (solo Neko tiene menú).
-- ============================================================

ALTER TABLE items ADD COLUMN IF NOT EXISTS marca_id INTEGER REFERENCES marcas(id);
ALTER TABLE item_grupos ADD COLUMN IF NOT EXISTS marca_id INTEGER REFERENCES marcas(id);
ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS marca_id INTEGER REFERENCES marcas(id);
CREATE INDEX IF NOT EXISTS idx_items_marca ON items(marca_id);
CREATE INDEX IF NOT EXISTS idx_item_grupos_marca ON item_grupos(marca_id);
CREATE INDEX IF NOT EXISTS idx_modifier_groups_marca ON modifier_groups(marca_id);

DO $$
DECLARE v_tid UUID; m_neko INTEGER;
BEGIN
  SELECT id INTO v_tid FROM tenants WHERE slug='neko';
  SELECT id INTO m_neko FROM marcas WHERE tenant_id=v_tid AND slug='neko';
  IF m_neko IS NULL THEN RAISE EXCEPTION 'Marca neko no encontrada'; END IF;
  UPDATE items           SET marca_id=m_neko WHERE tenant_id=v_tid AND marca_id IS NULL AND deleted_at IS NULL;
  UPDATE item_grupos     SET marca_id=m_neko WHERE tenant_id=v_tid AND marca_id IS NULL AND deleted_at IS NULL;
  UPDATE modifier_groups SET marca_id=m_neko WHERE tenant_id=v_tid AND marca_id IS NULL AND deleted_at IS NULL;
  RAISE NOTICE 'Items Neko: %', (SELECT count(*) FROM items WHERE tenant_id=v_tid AND marca_id=m_neko AND deleted_at IS NULL);
END $$;
