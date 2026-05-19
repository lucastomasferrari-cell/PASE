-- ═══════════════════════════════════════════════════════════════════════════
-- Fase C — external_order_id en ventas_pos para mapeo bidireccional
--
-- Hoy cuando Rappi/PeYa mandan un pedido, lo guardamos como venta_pos con
-- origen='webhook_rappi' pero el ID del pedido en el partner queda en
-- notas (texto suelto). Para llamarlos de vuelta (aceptar/cancelar/marcar
-- listo) necesitamos el ID original en una columna queryable.
--
-- 2 columnas:
--   - external_order_id: el ID que Rappi/PeYa/Deliverect usa para este pedido.
--   - external_provider: 'rappi' | 'pedidos-ya' | 'deliverect' (denormalizado
--     de origen para queries más simples).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS external_order_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS external_provider TEXT NULL
    CHECK (external_provider IS NULL OR external_provider IN ('rappi', 'pedidos-ya', 'deliverect'));

COMMENT ON COLUMN ventas_pos.external_order_id IS
  'ID del pedido en el partner externo (Rappi, PeYa, Deliverect). NULL si la venta es interna (POS, tienda propia).';
COMMENT ON COLUMN ventas_pos.external_provider IS
  'Partner que originó el pedido. NULL para ventas internas.';

-- Index para lookup rápido cuando el partner manda webhooks de status update
-- (el partner manda su external_order_id, lookupeamos por (provider, ext_id)).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_external_order
  ON ventas_pos(external_provider, external_order_id)
  WHERE external_order_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
