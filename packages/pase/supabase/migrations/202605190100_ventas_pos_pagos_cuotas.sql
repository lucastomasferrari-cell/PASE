-- ═══════════════════════════════════════════════════════════════════════════
-- ventas_pos_pagos.cuotas — soporte cuotas (3/6/12) típico AR
-- Sesión 2026-05-18 (roadmap A4.2)
--
-- En AR la mayoría de las ventas con tarjeta de crédito se hacen en
-- cuotas (3, 6, 12 cuotas sin interés vía promos bancarias). Hoy el POS
-- registra el monto total pero pierde la info de "esto fueron 6 cuotas
-- de $X".
--
-- Cambios:
--   - ALTER ventas_pos_pagos ADD COLUMN cuotas INTEGER NULL CHECK
--     (cuotas IS NULL OR cuotas BETWEEN 1 AND 24)
--   - NULL = sin cuotas (default — efectivo/débito/QR no son a cuotas)
--   - 1 = "1 pago" (típicamente débito o "1 cuota crédito sin interés")
--   - 3/6/12 = cuotas planeadas
--
-- Aditiva. No rompe lógica existente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas_pos_pagos
  ADD COLUMN IF NOT EXISTS cuotas INTEGER NULL
    CHECK (cuotas IS NULL OR cuotas BETWEEN 1 AND 24);

COMMENT ON COLUMN ventas_pos_pagos.cuotas IS
  'Número de cuotas pactadas con el cliente para este pago. NULL = no aplica (efectivo/débito/QR). 1 = pago único. 3/6/12 = típicos AR.';

NOTIFY pgrst, 'reload schema';
