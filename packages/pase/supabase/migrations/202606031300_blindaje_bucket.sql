-- 202606031300_blindaje_bucket.sql
-- Pedido Lucas 03-jun: la pantalla Herramientas → Blindaje (documentos
-- por local: habilitaciones, contratos, etc.) tira "no hay bucket" al
-- subir archivos.
--
-- El bucket `blindaje` nunca se creó en Storage. El frontend ya intenta
-- usarlo (upload + signedUrl + remove) desde el sprint inicial pero
-- nadie corrió el SQL que crea el bucket + sus policies.
--
-- Convención de path (frontend Blindaje.tsx:202):
--   {tenant_id}/{local_id}/{tipo}_{yyyymmdd}.{ext}
--
-- RLS sobre storage.objects:
--   - El primer segmento del path debe ser `auth_tenant_id()`.
--   - Esto aísla los docs entre tenants sin acoplarse al local (cualquier
--     user del tenant puede ver docs de cualquier local).
--   - Si en el futuro se quiere restringir por local, agregar:
--     (storage.foldername(name))[2]::int = ANY(auth_locales_visibles())

-- ─── 1. Crear el bucket (privado) ─────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('blindaje', 'blindaje', false)
ON CONFLICT (id) DO NOTHING;

-- ─── 2. RLS: aislamiento por tenant_id (primer segmento del path) ────────
DROP POLICY IF EXISTS "blindaje_tenant_select" ON storage.objects;
DROP POLICY IF EXISTS "blindaje_tenant_insert" ON storage.objects;
DROP POLICY IF EXISTS "blindaje_tenant_update" ON storage.objects;
DROP POLICY IF EXISTS "blindaje_tenant_delete" ON storage.objects;

CREATE POLICY "blindaje_tenant_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'blindaje'
    AND (storage.foldername(name))[1] = auth_tenant_id()::text
  );

CREATE POLICY "blindaje_tenant_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'blindaje'
    AND (storage.foldername(name))[1] = auth_tenant_id()::text
  );

CREATE POLICY "blindaje_tenant_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'blindaje'
    AND (storage.foldername(name))[1] = auth_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'blindaje'
    AND (storage.foldername(name))[1] = auth_tenant_id()::text
  );

CREATE POLICY "blindaje_tenant_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'blindaje'
    AND (storage.foldername(name))[1] = auth_tenant_id()::text
  );

NOTIFY pgrst, 'reload schema';
