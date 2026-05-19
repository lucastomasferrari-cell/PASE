-- ═══════════════════════════════════════════════════════════════════════════
-- Fase C — SKU externos en items para mapeo con partners
--
-- Cada partner (Rappi, PedidosYa, Deliverect, UberEats) tiene su propio
-- ID interno para nuestros productos. Cuando recibimos un webhook con
-- "product_id: xyz", necesitamos resolver a qué `items.id` corresponde
-- en COMANDA.
--
-- 4 columnas opcionales en items para los principales partners + columna
-- genérica JSON para futuras:
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS sku_rappi TEXT NULL,
  ADD COLUMN IF NOT EXISTS sku_pedidosya TEXT NULL,
  ADD COLUMN IF NOT EXISTS sku_deliverect TEXT NULL,
  ADD COLUMN IF NOT EXISTS sku_externos JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN items.sku_rappi IS 'ID del producto en Rappi (lo asigna el partner cuando hace pull/push del menú).';
COMMENT ON COLUMN items.sku_pedidosya IS 'ID del producto en PedidosYa.';
COMMENT ON COLUMN items.sku_deliverect IS 'ID del producto en Deliverect.';
COMMENT ON COLUMN items.sku_externos IS 'Mapa libre { partner: sku } para partners no top-3.';

-- Index parcial para lookups rápidos en webhooks. Filtra los NULL para
-- mantener el index chico.
CREATE INDEX IF NOT EXISTS idx_items_sku_rappi
  ON items(tenant_id, sku_rappi) WHERE sku_rappi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_sku_pedidosya
  ON items(tenant_id, sku_pedidosya) WHERE sku_pedidosya IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_sku_deliverect
  ON items(tenant_id, sku_deliverect) WHERE sku_deliverect IS NOT NULL;

NOTIFY pgrst, 'reload schema';
