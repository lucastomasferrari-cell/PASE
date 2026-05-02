-- ═══════════════════════════════════════════════════════════════════════════
-- Drop columnas saldo_mp_* de mp_credenciales (TASK 0.18 cleanup).
--
-- Contexto: estas columnas almacenaban el saldo "real" devuelto por
-- /users/{id}/mercadopago_account/balance (helper api/_mp-balance.js). Pero
-- ese endpoint requiere un scope que el access_token actual no tiene
-- (devuelve 403 ForbiddenApiError consistentemente desde el sprint MP).
-- En la práctica las columnas quedaban con su último valor o NULL.
--
-- Decisión arquitectural: quitar la card 'Saldo MP (API)' del frontend
-- (commit 37ceeb8). El saldo legacy calculado desde rr-/set-* sobre el
-- saldo_inicial es suficiente para conciliación. Si en el futuro se quiere
-- volver a leer balance desde MP API, se re-introducen.
--
-- Antes de aplicar este DROP:
--   * Frontend (src/pages/ConciliacionMP.tsx) ya no las lee — commit 37ceeb8.
--   * Backend (mp-process.js, mp-sync.js) ya no las escribe ni llama
--     fetchMpBalance — este mismo commit.
--   * api/_mp-balance.js eliminado.
--   * grep de las columnas en src/, api/, tests/ post-cleanup: 0 referencias.
--
-- DROP es irreversible. Aplicar en Supabase Studio cuando el deploy del
-- backend ya no las escriba (de lo contrario el próximo cron fallaría con
-- "column saldo_mp_actual does not exist").
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mp_credenciales DROP COLUMN IF EXISTS saldo_mp_actual;
ALTER TABLE mp_credenciales DROP COLUMN IF EXISTS saldo_mp_total;
ALTER TABLE mp_credenciales DROP COLUMN IF EXISTS saldo_mp_unavailable;
ALTER TABLE mp_credenciales DROP COLUMN IF EXISTS saldo_mp_actualizado_at;
