-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP pendiente: marcar ventas cobradas online cuyo CAE falló
-- 26-jun-2026
--
-- Fix audit 26-jun CRIT-4: el webhook MP de la tienda online cobra la venta
-- ANTES de intentar emitir AFIP. Si AFIP falla (timeout, cert vencido, AFIP
-- en mantenimiento, etc.), la venta queda `estado='cobrada'` SIN factura.
-- Eso incumple la obligación legal de emitir factura electrónica para venta
-- a consumidor final (Ley 27.349 + RG 4291).
--
-- Solución: marcar la venta con `afip_pendiente=true` y exponer ese flag al
-- POS / EERR para que el operador vea las ventas que necesitan emisión
-- manual. El reintento se hace desde el botón existente de /api/afip-cae.
--
-- Es aditivo: ventas viejas quedan con NULL (que se trata como FALSE en la UI).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS afip_pendiente BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS afip_ultimo_intento_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS afip_ultimo_error TEXT;

COMMENT ON COLUMN ventas_pos.afip_pendiente IS
  'TRUE cuando la venta fue cobrada (online o presencial) pero AFIP rechazó la emisión del CAE. El operador debe reintentar manualmente desde el POS. Se resetea a FALSE cuando AFIP emite con éxito.';

COMMENT ON COLUMN ventas_pos.afip_ultimo_error IS
  'Mensaje del último intento de emisión AFIP fallido (para debugging y mostrar al operador).';

-- Índice para que el POS filtre rápido las ventas pendientes de AFIP del local.
CREATE INDEX IF NOT EXISTS idx_ventas_pos_afip_pendiente
  ON ventas_pos (local_id, afip_pendiente)
  WHERE afip_pendiente = TRUE;

COMMIT;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'ventas_pos' AND column_name = 'afip_pendiente') = 1,
         'afip_pendiente no creada';
  RAISE NOTICE '✓ afip_pendiente listo';
END $$;
