-- 202606181400_pagos_venta_idempotency_uuid.sql
-- Rebuild offline COMANDA (Fase 1): un pago creado OFFLINE necesita linkear a su
-- venta por el uuid del cliente (la venta aún no tiene `id` bigint del server).
-- `ventas_pos_items` ya tiene `venta_idempotency_uuid`; `ventas_pos_pagos` NO.
-- Era el origen del bug `__pending_parent__` (el spike lo confirmó). Aditiva.
BEGIN;
ALTER TABLE ventas_pos_pagos ADD COLUMN IF NOT EXISTS venta_idempotency_uuid uuid;
CREATE INDEX IF NOT EXISTS idx_vpp_venta_idem ON ventas_pos_pagos(venta_idempotency_uuid);
COMMENT ON COLUMN ventas_pos_pagos.venta_idempotency_uuid IS
  'UUID cliente de la venta padre, para linkear pagos creados offline antes de que la venta tenga id bigint. Espejo de ventas_pos_items.venta_idempotency_uuid (rebuild offline 2026-06).';
COMMIT;
