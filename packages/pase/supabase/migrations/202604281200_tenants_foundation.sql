-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — ETAPA 1: Foundation schema multi-tenant.
--
-- Sienta la base para multi-tenant:
--   - Tabla `tenants` (con placeholder billing).
--   - Tabla `tenant_admins` (vínculo many-to-many usuario↔tenant para roles
--     dueño/admin; complemento, no usado en RLS aún).
--   - Tenant inicial 'Neko' con el slug 'neko'.
--   - usuarios.tenant_id (NULLABLE en este sprint; etapa 2 propaga).
--   - Backfill: TODOS los usuarios actuales → tenant Neko.
--   - Promoción: el usuario rol='dueno' activo (Lucas) → rol='superadmin',
--     tenant_id = NULL (queda fuera de cualquier tenant).
--   - CHECK constraint nuevo: rol = 'superadmin' OR tenant_id IS NOT NULL.
--   - CHECK rol actualizado: 6 roles permitidos.
--   - Helpers SECURITY DEFINER: auth_tenant_id(), auth_es_superadmin().
--
-- NO toca RLS (etapa 3). NO propaga tenant_id al resto de tablas (etapa 2).
-- Sistema sigue funcionando idéntico tras esta migración: el SELECT a
-- usuarios trae la fila del usuario logueado, ahora con tenant_id, pero
-- ninguna query del frontend lo usa todavía.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Tabla tenants -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          text NOT NULL,
  slug            text UNIQUE NOT NULL,
  activo          boolean NOT NULL DEFAULT true,
  plan            text,                      -- placeholder billing: 'trial', 'basic', 'pro'
  trial_ends_at   timestamptz,               -- placeholder billing
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_activo ON tenants(activo) WHERE activo = true;

-- RLS habilitada pero sin policies todavía. authenticated NO puede tocar
-- tenants hasta etapa 3 que crea las policies. service_role bypassa por
-- diseño, así que el script de aplicación (que corre con SUPABASE_SERVICE_KEY
-- equivalente vía POSTGRES_URL_NON_POOLING) puede insertar el tenant Neko.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- 2. Tabla tenant_admins -----------------------------------------------------
-- Complemento. No se usa en RLS en etapa 1; preparación para
-- multi-tenant-per-user futuro.

CREATE TABLE IF NOT EXISTS tenant_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id  integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  rol         text NOT NULL CHECK (rol IN ('dueno', 'admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_admins_tenant ON tenant_admins(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_admins_usuario ON tenant_admins(usuario_id);

ALTER TABLE tenant_admins ENABLE ROW LEVEL SECURITY;

-- 3. Insertar tenant Neko ----------------------------------------------------
-- Idempotente: ON CONFLICT no inserta si ya existe.

INSERT INTO tenants (nombre, slug, plan)
VALUES ('Neko', 'neko', 'pro')
ON CONFLICT (slug) DO NOTHING;

-- 4. usuarios.tenant_id ------------------------------------------------------

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_usuarios_tenant ON usuarios(tenant_id);

-- 5. Backfill: TODOS los usuarios → tenant Neko -----------------------------

UPDATE usuarios
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'neko')
 WHERE tenant_id IS NULL;

-- 6. Promoción a superadmin del dueño (Lucas) -------------------------------
-- Toma el usuario rol='dueno' activo. Si hay más de uno (no debería),
-- toma el de menor id (más antiguo).

DO $$
DECLARE
  v_lucas_id integer;
BEGIN
  SELECT id INTO v_lucas_id
    FROM usuarios
   WHERE rol = 'dueno' AND activo = true
   ORDER BY id ASC
   LIMIT 1;

  IF v_lucas_id IS NULL THEN
    RAISE EXCEPTION 'NO_DUENO_FOUND: no hay usuario rol=dueno activo para promover a superadmin';
  END IF;

  -- Promover: rol='superadmin', tenant_id=NULL.
  UPDATE usuarios
     SET rol = 'superadmin',
         tenant_id = NULL
   WHERE id = v_lucas_id;

  RAISE NOTICE 'Usuario id=% promovido a superadmin', v_lucas_id;
END $$;

-- 7. CHECK constraint en usuarios -------------------------------------------
-- Reglas:
--   a) rol válido (6 roles).
--   b) si rol != 'superadmin' → tenant_id NOT NULL (todo usuario de un
--      tenant tiene tenant_id seteado; solo superadmin queda fuera).

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_tenant_check;

ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (
  rol IN ('superadmin', 'dueno', 'admin', 'encargado', 'compras', 'cajero')
);

ALTER TABLE usuarios ADD CONSTRAINT usuarios_tenant_check CHECK (
  rol = 'superadmin' OR tenant_id IS NOT NULL
);

-- 8. Helpers SECURITY DEFINER -----------------------------------------------
-- auth_tenant_id(): tenant del usuario logueado. NULL para superadmin
--                   (porque su fila tiene tenant_id NULL).
-- auth_es_superadmin(): true si rol='superadmin' del usuario logueado.
--
-- En esta etapa NO modificamos auth_es_dueno_o_admin() ni
-- auth_locales_visibles() — eso va en etapa 3 cuando se reescribe RLS.

CREATE OR REPLACE FUNCTION auth_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM usuarios
   WHERE auth_id = auth.uid() AND activo
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auth_es_superadmin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
     WHERE auth_id = auth.uid()
       AND rol = 'superadmin'
       AND activo
  );
$$;

GRANT EXECUTE ON FUNCTION auth_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION auth_es_superadmin() TO authenticated;

-- 9. tenant_admins backfill --------------------------------------------------
-- Insertar 1 row por cada dueño/admin del tenant Neko (excepto el
-- superadmin Lucas que ahora tiene tenant_id NULL).
-- Idempotente vía UNIQUE (tenant_id, usuario_id) + ON CONFLICT.

INSERT INTO tenant_admins (tenant_id, usuario_id, rol)
SELECT u.tenant_id, u.id, u.rol
  FROM usuarios u
 WHERE u.rol IN ('dueno', 'admin')
   AND u.activo = true
   AND u.tenant_id IS NOT NULL
ON CONFLICT (tenant_id, usuario_id) DO NOTHING;
