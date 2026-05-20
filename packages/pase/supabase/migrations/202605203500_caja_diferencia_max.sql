-- ═══════════════════════════════════════════════════════════════════════════
-- Diferencia máxima permitida al cerrar caja (configurable por local)
--
-- Antes hardcoded $5000. Ahora cada local define su tolerancia. Si la
-- diferencia entre teórico y real al cerrar > diferencia_max, requiere
-- override del manager para forzar cierre.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS diferencia_max_cierre NUMERIC(10, 2) DEFAULT 5000;

COMMENT ON COLUMN comanda_local_settings.diferencia_max_cierre IS
  'Diferencia máxima permitida al cerrar turno sin override (en ARS). Default $5000.';

NOTIFY pgrst, 'reload schema';
