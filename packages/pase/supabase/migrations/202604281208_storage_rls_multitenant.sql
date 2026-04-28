-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — ETAPA 8: Storage RLS multi-tenant.
--
-- Diagnóstico (al ejecutar esta etapa):
--   - bucket 'empleados': 1 archivo (path: 1/1775828921722.pdf).
--   - bucket 'facturas': 6 archivos (paths: FACT-...).
--   - Total 7 archivos, todos del tenant Neko (único existente).
--
-- Volumen mínimo → no migramos paths físicos. En su lugar, las nuevas
-- policies aceptan dual-mode:
--   1. Paths con prefijo tenant: <tenant_id>/<resto> → solo accesible por
--      usuarios del tenant que matchea el prefijo.
--   2. Paths legacy SIN prefijo tenant → solo accesibles por usuarios del
--      tenant Neko (defensive — como solo Lucas usa el sistema, sus paths
--      legacy quedan en su tenant).
--   3. Superadmin bypassa todo.
--
-- Cuando se onboardee el primer tenant nuevo, el frontend debe subir a
-- paths con prefijo <tenant_id>/. La migración de los 7 archivos legacy
-- a prefijo Neko queda pendiente para una task futura (no urgente: solo
-- Lucas accede a esos archivos y la dual-policy le da pass).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. DROP policies viejas (las cuatro de facturas + 2 de "public" para empleados).
DROP POLICY IF EXISTS "facturas_read" ON storage.objects;
DROP POLICY IF EXISTS "facturas_upload" ON storage.objects;
DROP POLICY IF EXISTS "facturas_update" ON storage.objects;
DROP POLICY IF EXISTS "facturas_delete" ON storage.objects;
DROP POLICY IF EXISTS "public read" ON storage.objects;
DROP POLICY IF EXISTS "public upload" ON storage.objects;

-- 2. Helper: resolver tenant del path. Si el primer segmento del path
-- matchea un UUID válido, asumimos que es prefijo de tenant. Sino, asumimos
-- legacy = tenant Neko.
-- Implementado inline en cada policy con regex y subquery.

-- 3. Bucket 'facturas' — read/insert/update/delete con tenant filter.

CREATE POLICY "facturas_read_mt" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'facturas' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        -- Path legacy sin prefijo UUID: solo permite si caller es tenant Neko.
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

CREATE POLICY "facturas_upload_mt" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'facturas' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

CREATE POLICY "facturas_update_mt" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'facturas' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  )
  WITH CHECK (
    bucket_id = 'facturas' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

CREATE POLICY "facturas_delete_mt" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'facturas' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

-- 4. Bucket 'empleados' — mismo patrón.

CREATE POLICY "empleados_read_mt" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'empleados' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

CREATE POLICY "empleados_upload_mt" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'empleados' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

CREATE POLICY "empleados_update_mt" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'empleados' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  )
  WITH CHECK (
    bucket_id = 'empleados' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

CREATE POLICY "empleados_delete_mt" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'empleados' AND (
      auth_es_superadmin()
      OR (storage.foldername(name))[1] = auth_tenant_id()::text
      OR (
        COALESCE((storage.foldername(name))[1], '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = 'neko')
      )
    )
  );

-- 5. Bucket 'blindaje' (puede no existir, condicional).
DO $$
DECLARE
  v_neko_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'blindaje') THEN
    -- Drop legacy si existieran.
    EXECUTE 'DROP POLICY IF EXISTS "blindaje_read" ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS "blindaje_upload" ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS "blindaje_update" ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS "blindaje_delete" ON storage.objects';

    EXECUTE format('CREATE POLICY "blindaje_read_mt" ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = ''blindaje'' AND (
        auth_es_superadmin()
        OR (storage.foldername(name))[1] = auth_tenant_id()::text
        OR ((storage.foldername(name))[1] !~ %L AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = ''neko''))
      ))', v_neko_uuid_pattern);

    EXECUTE format('CREATE POLICY "blindaje_upload_mt" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = ''blindaje'' AND (
        auth_es_superadmin()
        OR (storage.foldername(name))[1] = auth_tenant_id()::text
        OR ((storage.foldername(name))[1] !~ %L AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = ''neko''))
      ))', v_neko_uuid_pattern);

    EXECUTE format('CREATE POLICY "blindaje_update_mt" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = ''blindaje'' AND (
        auth_es_superadmin()
        OR (storage.foldername(name))[1] = auth_tenant_id()::text
        OR ((storage.foldername(name))[1] !~ %L AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = ''neko''))
      ))
      WITH CHECK (bucket_id = ''blindaje'' AND (
        auth_es_superadmin()
        OR (storage.foldername(name))[1] = auth_tenant_id()::text
        OR ((storage.foldername(name))[1] !~ %L AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = ''neko''))
      ))', v_neko_uuid_pattern, v_neko_uuid_pattern);

    EXECUTE format('CREATE POLICY "blindaje_delete_mt" ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = ''blindaje'' AND (
        auth_es_superadmin()
        OR (storage.foldername(name))[1] = auth_tenant_id()::text
        OR ((storage.foldername(name))[1] !~ %L AND auth_tenant_id() = (SELECT id FROM tenants WHERE slug = ''neko''))
      ))', v_neko_uuid_pattern);
  END IF;
END $$;
