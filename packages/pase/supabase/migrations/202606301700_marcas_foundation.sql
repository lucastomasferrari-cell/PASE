-- ============================================================
-- Multi-marca · Fase 1: tabla `marcas` + `locales.marca_id`
-- Modelo: TENANT (grupo/dueño) → MARCA (agrupa locales) → LOCAL (sucursal).
-- Aditivo y seguro (no borra ni mueve datos). RLS dual.
-- Ver DISENO_MULTIMARCA_TENANTS.md.
-- ============================================================

-- 1. Tabla marcas ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS marcas (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  logo_url      TEXT,
  color_primary TEXT,
  orden         INTEGER NOT NULL DEFAULT 0,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, slug)
);

-- Default del tenant: permite INSERT desde el cliente sin pasar tenant_id
-- (igual que `roles`). auth_tenant_id() resuelve el tenant del usuario logueado.
ALTER TABLE marcas ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();

ALTER TABLE marcas ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquier usuario del tenant ve sus marcas (master data).
DROP POLICY IF EXISTS marcas_select ON marcas;
CREATE POLICY marcas_select ON marcas FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());

-- Escritura: solo dueño/admin del tenant (o superadmin).
DROP POLICY IF EXISTS marcas_write ON marcas;
CREATE POLICY marcas_write ON marcas FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

-- 2. locales.marca_id ------------------------------------------------------
ALTER TABLE locales ADD COLUMN IF NOT EXISTS marca_id INTEGER REFERENCES marcas(id);
CREATE INDEX IF NOT EXISTS idx_locales_marca ON locales(marca_id);

-- 3. Seed de las 3 marcas de Neko -----------------------------------------
-- Crea Neko / Maneki / Rene y asigna cada local por nombre.
-- ⚠️ El match por nombre asume: locales Neko prefijados "Neko",
-- Maneki contiene "maneki", Rene contiene "rene". CONFIRMAR antes de correr
-- (ver el SELECT de verificación en el chat). Los que no matchean quedan
-- en NULL y se asignan a mano.
DO $$
DECLARE
  v_tid   UUID;
  m_neko  INTEGER;
  m_man   INTEGER;
  m_rene  INTEGER;
BEGIN
  SELECT id INTO v_tid FROM tenants WHERE slug = 'neko';
  IF v_tid IS NULL THEN RAISE EXCEPTION 'Tenant neko no encontrado'; END IF;

  INSERT INTO marcas(tenant_id, nombre, slug, orden) VALUES (v_tid, 'Neko Sushi', 'neko', 1)
    ON CONFLICT (tenant_id, slug) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id INTO m_neko;
  INSERT INTO marcas(tenant_id, nombre, slug, orden) VALUES (v_tid, 'Maneki Sushi & Asian', 'maneki', 2)
    ON CONFLICT (tenant_id, slug) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id INTO m_man;
  INSERT INTO marcas(tenant_id, nombre, slug, orden) VALUES (v_tid, 'Rene Cantina', 'rene', 3)
    ON CONFLICT (tenant_id, slug) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id INTO m_rene;

  -- Asignación por nombre (solo locales aún sin marca).
  UPDATE locales SET marca_id = m_man
    WHERE tenant_id = v_tid AND marca_id IS NULL AND nombre ILIKE '%maneki%';
  UPDATE locales SET marca_id = m_rene
    WHERE tenant_id = v_tid AND marca_id IS NULL AND nombre ILIKE '%rene%';
  UPDATE locales SET marca_id = m_neko
    WHERE tenant_id = v_tid AND marca_id IS NULL AND nombre ILIKE '%neko%';

  RAISE NOTICE 'Marcas creadas. Locales sin marca aún: %',
    (SELECT count(*) FROM locales WHERE tenant_id = v_tid AND marca_id IS NULL);
END $$;
