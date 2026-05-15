-- ═══════════════════════════════════════════════════════════════════════════
-- Cash Management — breakdown por denominaciones en cierre de caja
-- ═══════════════════════════════════════════════════════════════════════════
-- Toast feature top ROI anti-fraude (audit 2026-05-15). Permite que el
-- cajero declare el total contando cada denominación (billetes y monedas)
-- en lugar de tipear un solo número.
--
-- Beneficios:
--   - Reduce errores de tipeo en cierre (típico: cajero suma mal o tipea mal).
--   - Auditable post-cierre: queda registrado el breakdown del arqueo.
--   - Detección de discrepancias por denominación específica.
--
-- Formato del JSON (denominaciones AR vigentes a may-2026):
--   {
--     "billetes": {
--       "10000": 5,  // 5 billetes de $10.000
--       "2000": 12,
--       "1000": 30,
--       "500": 20,
--       "200": 15,
--       "100": 8,
--       "50": 4,
--       "20": 10,
--       "10": 5
--     },
--     "monedas": {
--       "10": 0, "5": 0, "2": 0, "1": 0
--     },
--     "total": 117030  -- calculado client-side, redundante con breakdown
--   }
--
-- NULL si el cajero usó la versión rápida (input único). Sin breaking change.

ALTER TABLE turnos_caja
  ADD COLUMN IF NOT EXISTS efectivo_breakdown JSONB NULL;

COMMENT ON COLUMN turnos_caja.efectivo_breakdown IS
  'Cash Management: desglose por denominación del efectivo declarado al cierre. NULL si se usó input único. Schema: {billetes: {valor: cantidad}, monedas: {valor: cantidad}, total: number}.';
