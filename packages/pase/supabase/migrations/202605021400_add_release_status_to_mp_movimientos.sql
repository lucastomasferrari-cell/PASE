-- ═══════════════════════════════════════════════════════════════════════════
-- Agrega columnas para distinguir "venta" vs "ingreso al saldo" en pay-* y
-- detectar transacciones que no son approved (chargebacks, cancelled).
--
-- Contexto (TASK 0.18 — fase final):
--   El conciliador hoy mezcla "vendido" con "ingresado al saldo". MP libera
--   los cobros con T+1/T+2/T+10 según medio, y nuestra única columna `fecha`
--   guarda date_created (fecha de venta). Para mostrar 3 vistas distintas
--   (Ventas / Por cobrar / Ingresos al saldo) hace falta:
--     - money_release_date  ← cuándo MP libera al saldo
--     - money_release_status ← 'pending' o 'released'
--     - monto_bruto         ← transaction_amount (lo que pagó el cliente)
--                             Tab Ventas lo necesita; `monto` actual es neto.
--     - mp_status           ← payment.status real ('approved', 'cancelled',
--                             'charged_back', etc.). Si != 'approved',
--                             se marca anulado=true automáticamente.
--
-- Filas afectadas:
--   pay-* → todas las columnas nuevas se persisten desde mapPaymentToRows.
--   fee-*, tax-* → heredan money_release_date y money_release_status del
--                  payment padre. NO heredan monto_bruto (no aplica) ni
--                  mp_status (siempre 'approved' por convención).
--   rr-*, set-*  → quedan con NULL en las 4 columnas nuevas (no son
--                  emitidos desde payments/search). El conciliador no las
--                  filtra por estos campos para esos prefijos.
--
-- Indices:
--   - Parcial WHERE released:    optimiza tab "Ingresos al saldo".
--   - Compuesto status+date:     optimiza tab "Por cobrar" (pending) y
--                                queries del job diario fallback.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mp_movimientos
  ADD COLUMN IF NOT EXISTS money_release_date  timestamptz,
  ADD COLUMN IF NOT EXISTS money_release_status text,
  ADD COLUMN IF NOT EXISTS monto_bruto         numeric,
  ADD COLUMN IF NOT EXISTS mp_status           text;

CREATE INDEX IF NOT EXISTS idx_mp_mov_release_date_released
  ON mp_movimientos (money_release_date)
  WHERE money_release_status = 'released';

CREATE INDEX IF NOT EXISTS idx_mp_mov_release_status_date
  ON mp_movimientos (money_release_status, money_release_date);
