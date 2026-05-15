-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER mp_webhooks_test: agregar columna `source` para distinguir 2 pruebas
-- paralelas (Lucas 2026-05-14):
--
--   source = 1  → Prueba Conciliación 1 (app principal de PASE — todos los
--                 métodos de cobro: Point + QR + link + online + Rappi/...).
--   source = 2  → Prueba Conciliación 2 (app "prueba webhook" tipo Point —
--                 solo Point Smart presencial).
--
-- El endpoint distingue cuál es leyendo el query param `?source=1` o
-- `?source=2` de la URL configurada en cada app de MP.
--
-- NULL permitido para no romper la fila del smoke test inicial que se hizo
-- antes de esta migración. Default 0 = "indeterminado".
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mp_webhooks_test
  ADD COLUMN IF NOT EXISTS source smallint DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mp_webhooks_test_source_received
  ON mp_webhooks_test (source, received_at DESC);

COMMENT ON COLUMN mp_webhooks_test.source IS
  '1 = Prueba Conciliación 1 (app principal PASE, todos los métodos). 2 = Prueba Conciliación 2 (app de Point). 0 = legacy/smoke test pre-2026-05-14.';
