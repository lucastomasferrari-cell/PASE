-- ═══════════════════════════════════════════════════════════════════════════
-- Hotfix: ambigüedad en anular_gasto (PostgREST no resuelve sobrecarga)
--
-- Bug reportado por Anto (19-may): al intentar anular un gasto, error:
--   "Could not choose the best candidate function between:
--    public.anular_gasto(p_gasto_id => text, p_motivo => text),
--    public.anular_gasto(p_gasto_id => text, p_motivo => text, p_override_code => text)"
--
-- Causa raíz: la migration 202605180100_anular_con_override.sql creó la
-- versión NUEVA con p_override_code DEFAULT NULL, pero NO dropeó la vieja
-- de 2 args. PostgREST ve las dos firmas y cuando el frontend envía
-- p_override_code: null, no sabe cuál resolver.
--
-- Fix: dropear la versión vieja (sin override). La nueva acepta el caso
-- "sin código" porque p_override_code tiene DEFAULT NULL, así que cubre
-- ambos flujos.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS anular_gasto(text, text);

-- Verificamos que la nueva (con override) sigue ahí.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'anular_gasto'
      AND pg_get_function_identity_arguments(p.oid) = 'p_gasto_id text, p_motivo text, p_override_code text'
  ) THEN
    RAISE EXCEPTION 'anular_gasto(text,text,text) no existe. Re-aplicar migration 202605180100 primero.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
