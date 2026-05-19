-- ═══════════════════════════════════════════════════════════════════════════
-- ventas_pos_items.asiento_numero — soporte order-by-seat estilo Toast
-- Sesión 2026-05-18
--
-- Pedido Lucas (roadmap A4.1): "split por persona desde el inicio" en vez
-- de reconstruir la cuenta al cobrar. Each item se asigna a un asiento
-- numerado (1, 2, 3, ...) al momento de cargarlo. Después el split by
-- seat es trivial: SELECT WHERE asiento_numero = N.
--
-- Cambios:
--   - ALTER ventas_pos_items ADD COLUMN asiento_numero INT NULL.
--   - NULL = sin asignar (legacy / mostrador / canal pedido). El cobro
--     funciona igual sin este campo — es opcional.
--   - Cuando hay asiento_numero, las pantallas de cobro / split lo usan
--     para agrupar visualmente.
--
-- Aditiva: no rompe nada existente. Default NULL en filas viejas.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas_pos_items
  ADD COLUMN IF NOT EXISTS asiento_numero INTEGER NULL;

-- Index parcial — solo indexar las filas que SÍ tienen asiento (la
-- mayoría legacy va a ser NULL en mostrador / canales / etc.).
CREATE INDEX IF NOT EXISTS idx_vpi_venta_asiento
  ON ventas_pos_items(venta_id, asiento_numero)
  WHERE asiento_numero IS NOT NULL;

COMMENT ON COLUMN ventas_pos_items.asiento_numero IS
  'Número de asiento (1..N) al que se asigna este item. NULL = sin asignar (típico mostrador y pedidos online). Usado para split-by-seat al cobrar.';

NOTIFY pgrst, 'reload schema';
