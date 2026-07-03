-- =====================================================================
-- 202607031000_marketplace_fotos_upload_policies.sql
-- Permite subir fotos del perfil del local (MESA admin) al bucket público
-- `marketplace-fotos` directamente desde el navegador, en vez de pegar URLs.
--
-- Patrón idéntico a mp-qrs: lectura pública, y escritura del usuario
-- autenticado scopeada por tenant (la carpeta raíz del path = tenant_id).
-- Path convención: <tenant_id>/local-<localId>-<timestamp>.<ext>
-- =====================================================================

BEGIN;

-- Asegurar que el bucket sea público (lectura por URL sin auth).
UPDATE storage.buckets SET public = TRUE WHERE id = 'marketplace-fotos';

-- Lectura pública.
DROP POLICY IF EXISTS "marketplace_fotos_public_read" ON storage.objects;
CREATE POLICY "marketplace_fotos_public_read" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'marketplace-fotos');

-- Subida: sólo autenticado, y sólo dentro de su propia carpeta de tenant.
DROP POLICY IF EXISTS "marketplace_fotos_upload" ON storage.objects;
CREATE POLICY "marketplace_fotos_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'marketplace-fotos'
    AND auth_tenant_id() IS NOT NULL
    AND (storage.foldername(name))[1] = (auth_tenant_id())::text
  );

-- Reemplazo (upsert) dentro de la carpeta del tenant.
DROP POLICY IF EXISTS "marketplace_fotos_update" ON storage.objects;
CREATE POLICY "marketplace_fotos_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'marketplace-fotos'
    AND (storage.foldername(name))[1] = (auth_tenant_id())::text
  );

-- Borrado dentro de la carpeta del tenant (para sacar fotos).
DROP POLICY IF EXISTS "marketplace_fotos_delete" ON storage.objects;
CREATE POLICY "marketplace_fotos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'marketplace-fotos'
    AND (storage.foldername(name))[1] = (auth_tenant_id())::text
  );

COMMIT;
