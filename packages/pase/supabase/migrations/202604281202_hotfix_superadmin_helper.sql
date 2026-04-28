-- ═══════════════════════════════════════════════════════════════════════════
-- HOTFIX URGENTE — TASK 0.15.
--
-- La etapa 1 (202604281200_tenants_foundation.sql) promovió al usuario id=1
-- de rol='dueno' a rol='superadmin'. Pero auth_es_dueno_o_admin() solo
-- reconocía rol IN ('dueno','admin'). Resultado: el superadmin caía al ELSE
-- de auth_locales_visibles() → buscaba en usuario_locales (vacío para él) →
-- ARRAY[]::integer[] → todas las RLS policies con local_id = ANY(...) le
-- denegaban todo. En producción se veía como "todo en cero".
--
-- Fix: extender auth_es_dueno_o_admin() para incluir 'superadmin'. Esto
-- coincide con lo que iba a hacer Etapa 3 igualmente; lo adelantamos para
-- restaurar el sistema. Ya aplicado en BD via flow oficial; esta migration
-- es la versión formal versionada en repo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION auth_es_dueno_o_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol IN ('superadmin', 'dueno', 'admin')
      AND activo
  );
$$;
