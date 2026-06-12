-- ============================================================
-- 202606122000_medios_cobro_unificado.sql
-- Tier 1 #3: UN catálogo de medios de cobro para PASE+COMANDA.
-- medios_cobro absorbe a metodos_cobro y gana tenant_id (fix de
-- bug multi-tenant real: la tabla era compartida entre tenants).
-- metodos_cobro queda como VIEW de compatibilidad (clientes
-- COMANDA ya deployados); la tabla vieja se conserva renombrada.
-- ============================================================

BEGIN;

-- 1) Columnas nuevas ---------------------------------------------------------
ALTER TABLE medios_cobro
  ADD COLUMN IF NOT EXISTS tenant_id  UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS slug       TEXT,
  ADD COLUMN IF NOT EXISTS emoji      TEXT,
  ADD COLUMN IF NOT EXISTS pide_vuelto BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2) Backfill multi-tenant ---------------------------------------------------
-- 2a. Filas con local: heredan el tenant del local.
UPDATE medios_cobro mc SET tenant_id = l.tenant_id
  FROM locales l WHERE mc.local_id = l.id AND mc.tenant_id IS NULL;

-- 2b. Filas globales (local NULL, sin tenant): clonar una copia POR TENANT
--     existente (cada tenant pasa a tener su propio catálogo).
--     tenants no tiene deleted_at/estado pero SÍ activo (soft-deactivate vía
--     fn_set_tenant_activo) → excluimos los desactivados del clon.
INSERT INTO medios_cobro (tenant_id, local_id, nombre, cuenta_destino, activo, orden, pide_vuelto)
SELECT t.id, NULL, g.nombre, g.cuenta_destino, g.activo, g.orden, FALSE
  FROM medios_cobro g
 CROSS JOIN tenants t
 WHERE g.tenant_id IS NULL AND g.local_id IS NULL
   AND t.activo = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM medios_cobro x
      WHERE x.tenant_id = t.id AND x.local_id IS NULL
        AND upper(x.nombre) = upper(g.nombre)
   );

-- 2c. Borrar las originales sin tenant (ya clonadas) y endurecer.
DELETE FROM medios_cobro WHERE tenant_id IS NULL;
ALTER TABLE medios_cobro ALTER COLUMN tenant_id SET NOT NULL;

-- 3) Slug + pide_vuelto ------------------------------------------------------
UPDATE medios_cobro
   SET slug = btrim(regexp_replace(lower(translate(nombre,
              'ÁÉÍÓÚÜáéíóúüÑñ', 'AEIOUUaeiouuNn')), '[^a-z0-9]+', '_', 'g'), '_')
 WHERE slug IS NULL;
-- colisiones de slug dentro del mismo (tenant, scope): sufijo con id
UPDATE medios_cobro mc SET slug = mc.slug || '_' || mc.id
 WHERE EXISTS (
   SELECT 1 FROM medios_cobro x
    WHERE x.tenant_id = mc.tenant_id
      AND COALESCE(x.local_id, 0) = COALESCE(mc.local_id, 0)
      AND x.slug = mc.slug AND x.id < mc.id
 );
ALTER TABLE medios_cobro ALTER COLUMN slug SET NOT NULL;
UPDATE medios_cobro SET pide_vuelto = TRUE WHERE slug LIKE 'efectivo%';

-- 4) Merge de metodos_cobro (COMANDA) ---------------------------------------
-- 4a. Match por (tenant, scope, slug): copiar emoji + pide_vuelto.
UPDATE medios_cobro mc
   SET emoji = COALESCE(mc.emoji, m.emoji),
       pide_vuelto = mc.pide_vuelto OR m.pide_vuelto
  FROM metodos_cobro m
 WHERE m.deleted_at IS NULL
   AND mc.tenant_id = m.tenant_id
   AND COALESCE(mc.local_id, 0) = COALESCE(m.local_id, 0)
   AND mc.slug = m.slug;

-- 4b. Los que no matchean ni por slug ni por nombre: insertar (orden 100+ para
--     que queden después de los de PASE; sin cuenta_destino — lo setea el dueño).
INSERT INTO medios_cobro (tenant_id, local_id, nombre, slug, emoji, pide_vuelto, activo, orden, cuenta_destino)
SELECT m.tenant_id, m.local_id, m.nombre, m.slug, m.emoji, m.pide_vuelto, m.activo, 100 + m.orden, NULL
  FROM metodos_cobro m
 WHERE m.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM medios_cobro mc
      WHERE mc.tenant_id = m.tenant_id
        AND COALESCE(mc.local_id, 0) = COALESCE(m.local_id, 0)
        AND (mc.slug = m.slug OR upper(mc.nombre) = upper(m.nombre))
   );

-- 5) Uniques nuevos (con tenant) + limpieza del viejo ------------------------
ALTER TABLE medios_cobro DROP CONSTRAINT IF EXISTS medios_cobro_nombre_local_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_medios_cobro_nombre
  ON medios_cobro (tenant_id, COALESCE(local_id, 0), upper(nombre))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_medios_cobro_slug
  ON medios_cobro (tenant_id, COALESCE(local_id, 0), slug)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_medios_cobro_tenant ON medios_cobro (tenant_id, activo) WHERE deleted_at IS NULL;

-- 6) updated_at trigger (metodos_cobro lo tenía, medios_cobro no) ------------
DROP TRIGGER IF EXISTS trg_medios_cobro_set_updated_at ON medios_cobro;
CREATE TRIGGER trg_medios_cobro_set_updated_at BEFORE UPDATE ON medios_cobro
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- 7) RLS tenant-scoped (reemplaza el select USING(true)) ---------------------
-- comanda_auth_tiene_permiso (202605292030) retorna false — nunca excepción —
-- para usuarios sin perfil COMANDA, así que es segura en policy.
DROP POLICY IF EXISTS "mc_select" ON medios_cobro;
DROP POLICY IF EXISTS "mc_write" ON medios_cobro;
CREATE POLICY mc_select ON medios_cobro FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR tenant_id = auth_tenant_id()
    )
  );
CREATE POLICY mc_write ON medios_cobro FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND (
        auth_es_dueno_o_admin()
        OR auth_tiene_permiso('configuracion')
        OR comanda_auth_tiene_permiso('comanda.config.editar')
      )
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND (
        auth_es_dueno_o_admin()
        OR auth_tiene_permiso('configuracion')
        OR comanda_auth_tiene_permiso('comanda.config.editar')
      )
    )
  );

-- 8) metodos_cobro → legacy + VIEW de compatibilidad --------------------------
-- Clientes COMANDA ya deployados siguen consultando "metodos_cobro" hasta que
-- refresquen el bundle — la view los mantiene vivos sin downtime.
ALTER TABLE metodos_cobro RENAME TO _metodos_cobro_legacy_20260612;
REVOKE ALL ON _metodos_cobro_legacy_20260612 FROM authenticated, anon, PUBLIC;

CREATE VIEW metodos_cobro
WITH (security_invoker = true) AS
SELECT id, tenant_id, local_id, created_at, updated_at, deleted_at,
       nombre, slug, emoji, pide_vuelto, activo, orden
  FROM medios_cobro;
GRANT SELECT, INSERT, UPDATE ON metodos_cobro TO authenticated;

COMMIT;
