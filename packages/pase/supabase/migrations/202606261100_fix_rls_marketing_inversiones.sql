-- ═══════════════════════════════════════════════════════════════════════════
-- Fix RLS cross-tenant en marketing_inversiones
-- 26-jun-2026
--
-- Fix audit 26-jun CRIT-5: la policy original creada en 202606250500 NO
-- chequeaba `tenant_id`:
--
--   USING  (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
--
-- Eso permitía que cualquier dueño/admin de cualquier tenant viera/escribiera
-- registros con `local_id IS NULL` (típico para pauta "a nivel marca"), o
-- incluso insertara filas con `tenant_id` ajeno y la RLS las aceptaba.
--
-- Patrón correcto (igual al resto del repo, incluyendo accesos_audit en la
-- misma fecha): filtrar SIEMPRE por `tenant_id = auth_tenant_id()`.
--
-- Aditivo y seguro: solo reescribe la policy, no toca data.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DROP POLICY IF EXISTS "inversiones_by_local" ON marketing_inversiones;

CREATE POLICY "inversiones_by_tenant_local" ON marketing_inversiones
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()::text
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()::text
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
  );

COMMIT;

-- Verificación
DO $$
DECLARE v_policy_count INT;
BEGIN
  SELECT COUNT(*) INTO v_policy_count FROM pg_policies
   WHERE tablename = 'marketing_inversiones' AND policyname = 'inversiones_by_tenant_local';
  ASSERT v_policy_count = 1, 'policy inversiones_by_tenant_local no creada';
  RAISE NOTICE '✓ RLS marketing_inversiones ahora chequea tenant_id';
END $$;
