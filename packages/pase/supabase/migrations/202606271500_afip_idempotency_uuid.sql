-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP request_uuid persistente para idempotency cross-retry
-- 27-jun-2026
--
-- Bug detectado por code-review: el flujo de cobro online genera
-- `request_uuid = mp-{paymentId}-venta-{ventaId}` para llamar AFIP. Si AFIP
-- emite el CAE pero la respuesta HTTP se pierde antes de marcar la venta,
-- el reintento manual desde COMANDA → AFIP pendientes genera OTRO uuid
-- (`retry-{ventaId}-{ts}`). AFIP procesa como request nuevo → DOS facturas
-- con números distintos para la misma venta = problema fiscal.
--
-- Fix: persistir el request_uuid en ventas_pos.afip_request_uuid. El primer
-- intento lo setea; el retry lo reutiliza para que AFIP devuelva el CAE
-- cacheado (la RPC fn_emitir_factura tiene idempotency por request_uuid).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS afip_request_uuid TEXT;

COMMENT ON COLUMN ventas_pos.afip_request_uuid IS
  'Request UUID usado para llamar AFIP. Se setea en el primer intento y se reutiliza en retries para garantizar idempotency contra doble emisión (fix code-review 27-jun).';

COMMIT;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'ventas_pos' AND column_name = 'afip_request_uuid') = 1,
         'afip_request_uuid no creada';
  RAISE NOTICE '✓ ventas_pos.afip_request_uuid listo';
END $$;
