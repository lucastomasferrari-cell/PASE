-- ============================================================
-- 202607021800_medios_cobro_sectores.sql
-- Agrega visibilidad por sector (salon/mostrador/pedidos) a los
-- métodos de cobro. NULL = visible en todos los sectores (back-compat).
-- ============================================================

ALTER TABLE medios_cobro
  ADD COLUMN IF NOT EXISTS sectores_visibles TEXT[];

COMMENT ON COLUMN medios_cobro.sectores_visibles IS
  'Sectores donde se muestra este medio: salon, mostrador, pedidos. NULL = todos.';
