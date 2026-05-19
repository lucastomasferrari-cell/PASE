-- ═══════════════════════════════════════════════════════════════════════════
-- Drop la firma vieja de anular_movimiento (sin p_override_code)
-- Sesión 2026-05-18
--
-- Bug encontrado al aplicar 202605182000: Postgres permite function
-- overloading por signature. Cuando hicimos CREATE OR REPLACE con 3 args
-- (p_mov_id, p_motivo, p_override_code), se creó una RPC NUEVA en vez de
-- reemplazar la vieja de 2 args. Quedaron las dos coexistiendo:
--   - anular_movimiento(text, text)               ← vieja, sin gate ⚠️
--   - anular_movimiento(text, text, text)         ← nueva, con gate
--
-- Si el cliente llama con 2 args, PostgREST resuelve a la vieja → bypassa
-- el override completo. Fix: drop la vieja.
--
-- El cliente nuevo siempre pasa los 3 args (aunque p_override_code sea
-- null) gracias al spread operator en la llamada. Ver Caja.tsx.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS anular_movimiento(text, text);

NOTIFY pgrst, 'reload schema';
