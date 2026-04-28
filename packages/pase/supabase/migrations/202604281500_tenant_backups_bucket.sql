-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.17 — ETAPA 1: bucket tenant-backups + RLS estricta superadmin.
--
-- Crea el bucket privado donde el cron diario (api/backup-tenants.js)
-- guarda 1 archivo .json.gz por tenant por día. Retención 30 días la
-- maneja el cron de cleanup (api/backup-cleanup.js).
--
-- RLS: solo superadmin puede leer/escribir vía authenticated. service_role
-- (que usa el cron) bypassa por diseño. Ningún usuario regular del tenant
-- puede ver ni descargar backups.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES ('tenant-backups', 'tenant-backups', false)
ON CONFLICT (id) DO NOTHING;

-- DROP defensivo (idempotente).
DROP POLICY IF EXISTS "tenant_backups_superadmin_select" ON storage.objects;
DROP POLICY IF EXISTS "tenant_backups_superadmin_insert" ON storage.objects;
DROP POLICY IF EXISTS "tenant_backups_superadmin_update" ON storage.objects;
DROP POLICY IF EXISTS "tenant_backups_superadmin_delete" ON storage.objects;

CREATE POLICY "tenant_backups_superadmin_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tenant-backups' AND auth_es_superadmin());

CREATE POLICY "tenant_backups_superadmin_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tenant-backups' AND auth_es_superadmin());

CREATE POLICY "tenant_backups_superadmin_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'tenant-backups' AND auth_es_superadmin())
  WITH CHECK (bucket_id = 'tenant-backups' AND auth_es_superadmin());

CREATE POLICY "tenant_backups_superadmin_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'tenant-backups' AND auth_es_superadmin());
