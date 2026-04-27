-- ═══════════════════════════════════════════════════════════════════════════
-- PARTE B de TASK 0.11: agregar columnas para saldo real desde API MP.
--
-- Hoy mp_credenciales.saldo_disponible se calcula manualmente:
--   saldo_inicial (manual) + SUM(monto rr-* approved post-corte)
-- Riesgo: si se pierde un movimiento o se duplica, queda descuadrado y no
-- hay forma de detectarlo.
--
-- Estas columnas guardan el saldo REAL devuelto por la API de MP en cada
-- sync. La UI muestra ambos valores lado a lado durante 1-2 semanas para
-- detectar descuadres legacy. Después se elimina el cálculo manual.
--
-- saldo_mp_actual         = available_balance (lo que está liberado)
-- saldo_mp_total          = total_amount (released + pending)
-- saldo_mp_unavailable    = unavailable_balance (pending de liberación)
-- saldo_mp_actualizado_at = timestamp de la última lectura de la API
--
-- Todas nullable: las filas existentes quedan en NULL hasta el próximo sync.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mp_credenciales
  ADD COLUMN IF NOT EXISTS saldo_mp_actual numeric,
  ADD COLUMN IF NOT EXISTS saldo_mp_total numeric,
  ADD COLUMN IF NOT EXISTS saldo_mp_unavailable numeric,
  ADD COLUMN IF NOT EXISTS saldo_mp_actualizado_at timestamptz;
