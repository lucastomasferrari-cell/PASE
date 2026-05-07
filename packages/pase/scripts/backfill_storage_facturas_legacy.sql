-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL DE STORAGE FACTURAS LEGACY (sprint 7 - BLOCKER #4)
--
-- ESTADO: NO EJECUTAR HOY. Template para ejecución pre-onboarding del
-- segundo tenant productivo.
--
-- Contexto: la policy `facturas_read_mt` (migration 202604281208_storage_
-- rls_multitenant.sql) tiene un branch legacy que permite paths SIN UUID
-- prefix si el caller es del tenant Neko. Cuando se onboardee el segundo
-- tenant, ese branch deja una ventana donde paths legacy de Neko podrían
-- leakar al nuevo tenant (o viceversa).
--
-- Este script renombra los objects sin prefix UUID prependiendo el UUID
-- del tenant Neko, para que después se pueda eliminar el branch legacy
-- de la policy.
-- ═══════════════════════════════════════════════════════════════════════════

-- PASO 1 — Verificar el estado actual ANTES de ejecutar.
-- Esperado: > 0 si hay paths legacy. Anotar el número.
SELECT count(*) AS objects_legacy_sin_prefix
FROM storage.objects
WHERE bucket_id = 'facturas'
  AND name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/';

-- PASO 2 — Confirmar el UUID del tenant Neko.
-- Esperado: '5841143c-5594-4728-99c6-a313d40618e6' (verificar antes de pegar abajo).
SELECT id AS neko_uuid FROM tenants WHERE slug = 'neko';

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 3 — BACKFILL.
-- Reemplazar <NEKO_UUID> con el UUID real del paso 2.
-- ⚠️ CORRER UNA SOLA VEZ. Si falla a mitad, investigar antes de re-run.
-- ═══════════════════════════════════════════════════════════════════════════

/*
BEGIN;

UPDATE storage.objects
SET name = '5841143c-5594-4728-99c6-a313d40618e6/' || name
WHERE bucket_id = 'facturas'
  AND name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/';

-- Verificar resultado: debe ser 0.
SELECT count(*) AS quedaron_legacy
FROM storage.objects
WHERE bucket_id = 'facturas'
  AND name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/';

-- Si el count es 0, ejecutar:
-- COMMIT;
-- Sino:
-- ROLLBACK;
*/

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 4 — Crear migration de cleanup que elimina el branch legacy.
--
-- Migration nueva (timestamp post-backfill, ej. 202607XX_storage_facturas_no_legacy.sql):
--
--   DROP POLICY IF EXISTS "facturas_read_mt" ON storage.objects;
--
--   CREATE POLICY "facturas_read_mt" ON storage.objects FOR SELECT TO authenticated
--   USING (
--     bucket_id = 'facturas' AND (
--       auth_es_superadmin()
--       OR (storage.foldername(name))[1] = auth_tenant_id()::text
--     )
--   );
--
-- (Aplicar mismo patrón a facturas_upload, facturas_update, facturas_delete
-- que tengan el mismo branch legacy.)
-- ═══════════════════════════════════════════════════════════════════════════

-- PASO 5 — Verificación post-cleanup.
-- Login como user del tenant Neko, intentar listar/descargar archivos: debe funcionar.
-- Login como user del segundo tenant, intentar descargar archivo de Neko (con path
-- conocido) → debe RAISE permission denied.
