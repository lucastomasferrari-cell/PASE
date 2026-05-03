-- ═══════════════════════════════════════════════════════════════════════════
-- Agrega columnas anulado/anulado_motivo/anulado_at a mp_movimientos.
--
-- Contexto (TASK 0.18 final — bug discovered post Fase 2):
--   La tabla `movimientos` (tesorería operativa) tiene esas 3 columnas hace
--   tiempo. Yo asumí que `mp_movimientos` también las tenía y emití código
--   en Fase 2 (mapPaymentToRows) y Fase 3 (mp-update-pending-releases) que
--   las usa. El backfill ?backfill=10 falló con "column anulado does not
--   exist" porque NUNCA se habían agregado a mp_movimientos.
--
-- Caso de uso de las nuevas columnas:
--   - mapPaymentToRows: si payment.status != 'approved' (charged_back,
--     cancelled, refunded), emite la fila con anulado=true para que el
--     conciliador la oculte sin perder histórico.
--   - mp-update-pending-releases: filtra candidatos con anulado != true
--     (no reintenta GET sobre filas ya descartadas) + marca anulado=true
--     cuando MP responde 404 o status no-approved.
--   - Frontend conciliador (Fase 5 pendiente): filtros de cada tab incluyen
--     anulado != true para no contar en KPIs.
--
-- Distinto de `conciliado`:
--   - `conciliado` (boolean default false, agregado en 20260410_mp_conciliacion):
--     egresos justificados contra factura/gasto. Concepto contable manual.
--   - `anulado` (este commit): fila inválida automáticamente (status MP
--     cambió, payment 404, refund completo). Concepto técnico/automático.
--
-- Index:
--   - Partial WHERE anulado=false: optimiza queries del conciliador que
--     filtran "movimientos vigentes" (la mayoría). Tabla crece monotónica
--     y los anulados son <5% del total esperado.
--
-- Default false NOT NULL: filas pre-existentes (mp_movimientos creados
-- antes de esta migration) quedan automáticamente anulado=false. Coherente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mp_movimientos
  ADD COLUMN IF NOT EXISTS anulado        boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS anulado_motivo text,
  ADD COLUMN IF NOT EXISTS anulado_at     timestamptz;

CREATE INDEX IF NOT EXISTS idx_mp_mov_anulado_false
  ON mp_movimientos (id)
  WHERE anulado = false;
