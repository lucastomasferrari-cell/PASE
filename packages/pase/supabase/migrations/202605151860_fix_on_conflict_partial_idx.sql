-- ═══════════════════════════════════════════════════════════════════════════
-- BUG FIX — ON CONFLICT vs UNIQUE INDEX partial en movimientos_caja
-- ═══════════════════════════════════════════════════════════════════════════
-- Descubierto el 2026-05-15 probando cobro en COMANDA. Error real:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Causa: en F1.6b creé el índice `idx_movimientos_caja_idempotency` como
-- UNIQUE PARTIAL con `WHERE idempotency_key IS NOT NULL`. Postgres requiere
-- que un `ON CONFLICT (col)` matchee el predicado del índice — sin
-- especificar el WHERE en el INSERT, no hay match.
--
-- Fix: hacer el índice NO partial. Postgres ya trata NULL != NULL en UNIQUE
-- por SQL standard, por lo que múltiples filas con idempotency_key=NULL
-- siguen permitidas. El espacio extra es despreciable.
--
-- Mismo fix aplicado para ventas_pos_overrides y ventas_pos.cobro_idempotency_key
-- por consistencia, aunque hoy esas RPCs no usan ON CONFLICT con ellos.

DROP INDEX IF EXISTS idx_movimientos_caja_idempotency;
CREATE UNIQUE INDEX idx_movimientos_caja_idempotency
  ON movimientos_caja(idempotency_key);

DROP INDEX IF EXISTS idx_ventas_pos_overrides_idempotency;
CREATE UNIQUE INDEX idx_ventas_pos_overrides_idempotency
  ON ventas_pos_overrides(idempotency_key);

DROP INDEX IF EXISTS idx_ventas_pos_cobro_idempotency;
CREATE UNIQUE INDEX idx_ventas_pos_cobro_idempotency
  ON ventas_pos(cobro_idempotency_key);

-- Verificación post-migration:
--   DO $$ BEGIN
--     PERFORM 1 FROM pg_indexes WHERE indexname='idx_movimientos_caja_idempotency' AND indexdef NOT LIKE '%WHERE%';
--     IF NOT FOUND THEN RAISE EXCEPTION 'Fix no aplicado correctamente'; END IF;
--   END $$;
