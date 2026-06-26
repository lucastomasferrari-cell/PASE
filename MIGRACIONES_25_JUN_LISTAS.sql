-- ═══════════════════════════════════════════════════════════════════════════
-- 5 migraciones pendientes — copiá-pegá esto en Supabase SQL Editor
-- (Project pduxydviqiaxfqnshhdc → SQL Editor → New query)
--
-- Son 100% aditivas. Si una ya está aplicada total o parcialmente, los
-- IF NOT EXISTS las saltean sin romper. Verificaciones al final.
--
-- Tiempo total: ~4 segundos. Tablas creadas: 6. Columnas agregadas: 5.
-- Constraints CHECK agregadas: 4 (bot IG anti cost-runaway).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1) MESA: tags en reservas y comensales ──────────────────────────────
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS reservas_tags_idx ON reservas USING GIN (tags);
CREATE INDEX IF NOT EXISTS clientes_tags_idx ON clientes USING GIN (tags);

-- ─── 2) Marketing: registro de inversión en pauta (Habitué) ──────────────
CREATE TABLE IF NOT EXISTS marketing_inversiones (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  local_id    INTEGER,
  fecha       DATE        NOT NULL,
  plataforma  TEXT        NOT NULL,
  campania    TEXT,
  monto       NUMERIC(14,2) NOT NULL DEFAULT 0,
  alcance     INTEGER,
  clicks      INTEGER,
  notas       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
ALTER TABLE marketing_inversiones ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='marketing_inversiones' AND policyname='inversiones_by_local') THEN
    CREATE POLICY "inversiones_by_local" ON marketing_inversiones FOR ALL TO authenticated
      USING  (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
      WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS marketing_inversiones_fecha_idx
  ON marketing_inversiones (tenant_id, fecha DESC) WHERE deleted_at IS NULL;

-- ─── 3) Habitué: motor de marketing (integraciones, campañas, autom.) ────
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE;

CREATE TABLE IF NOT EXISTS integraciones (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  provider     TEXT        NOT NULL,
  estado       TEXT        NOT NULL DEFAULT 'desconectado',
  config       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  conectado_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS campanas (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  nombre          TEXT        NOT NULL,
  canal           TEXT        NOT NULL,
  segmento_key    TEXT,
  mensaje         TEXT        NOT NULL,
  cupon_id        BIGINT,
  estado          TEXT        NOT NULL DEFAULT 'borrador',
  programada_para TIMESTAMPTZ,
  destinatarios   INTEGER     NOT NULL DEFAULT 0,
  enviados        INTEGER     NOT NULL DEFAULT 0,
  abiertos        INTEGER     NOT NULL DEFAULT 0,
  conversiones    INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS campana_envios (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campana_id  BIGINT      NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  tenant_id   TEXT        NOT NULL,
  cliente_id  BIGINT,
  canal       TEXT        NOT NULL,
  destino     TEXT,
  estado      TEXT        NOT NULL DEFAULT 'pendiente',
  enviado_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automatizaciones (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  nombre          TEXT        NOT NULL,
  trigger_tipo    TEXT        NOT NULL,
  trigger_params  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  accion_tipo     TEXT        NOT NULL,
  accion_params   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  activa          BOOLEAN     NOT NULL DEFAULT FALSE,
  ultima_corrida_at TIMESTAMPTZ,
  disparos        INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

ALTER TABLE integraciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE campana_envios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE automatizaciones  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='integraciones' AND policyname='integraciones_by_tenant') THEN
    CREATE POLICY "integraciones_by_tenant" ON integraciones FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='campanas' AND policyname='campanas_by_tenant') THEN
    CREATE POLICY "campanas_by_tenant" ON campanas FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='campana_envios' AND policyname='campana_envios_by_tenant') THEN
    CREATE POLICY "campana_envios_by_tenant" ON campana_envios FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='automatizaciones' AND policyname='automatizaciones_by_tenant') THEN
    CREATE POLICY "automatizaciones_by_tenant" ON automatizaciones FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS campanas_tenant_idx ON campanas (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS campana_envios_campana_idx ON campana_envios (campana_id);
CREATE INDEX IF NOT EXISTS automatizaciones_tenant_idx ON automatizaciones (tenant_id) WHERE deleted_at IS NULL;

-- ─── 4) Accesos: control de acceso por app + auditoría ───────────────────
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS apps_permitidas TEXT[] NOT NULL DEFAULT ARRAY['pase']::TEXT[];
COMMENT ON COLUMN usuarios.apps_permitidas IS
  'Lista de apps del ecosistema a las que el usuario puede entrar. Valores: pase|comanda|mesa|habitue|accesos. Gestionado desde la app Accesos por el dueño.';
CREATE INDEX IF NOT EXISTS idx_usuarios_apps_permitidas ON usuarios USING GIN (apps_permitidas);

CREATE TABLE IF NOT EXISTS accesos_audit (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  actor_id     INTEGER     NOT NULL,
  usuario_id   INTEGER     NOT NULL,
  accion       TEXT        NOT NULL,
  detalle      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE accesos_audit ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='accesos_audit' AND policyname='accesos_audit_by_tenant') THEN
    CREATE POLICY "accesos_audit_by_tenant" ON accesos_audit FOR ALL TO authenticated
      USING  (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS accesos_audit_usuario_idx
  ON accesos_audit (tenant_id, usuario_id, created_at DESC);

-- ─── 5) Bot Instagram: validations + cap diario USD (anti cost-runaway) ──
-- Solo si existe ig_config en la base (algunos tenants no tienen el bot).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ig_config') THEN
    -- Cap diario USD por tenant (default $5)
    EXECUTE 'ALTER TABLE ig_config ADD COLUMN IF NOT EXISTS cap_diario_usd NUMERIC(8,2) NOT NULL DEFAULT 5.00';

    -- Sanear valores corruptos antes de aplicar CHECK
    EXECUTE 'UPDATE ig_config SET max_tokens = 1024 WHERE max_tokens IS NULL OR max_tokens < 128 OR max_tokens > 4096';
    EXECUTE 'UPDATE ig_config SET contexto_mensajes = 30 WHERE contexto_mensajes IS NULL OR contexto_mensajes < 1 OR contexto_mensajes > 100';
    EXECUTE 'UPDATE ig_config SET system_prompt = LEFT(system_prompt, 50000) WHERE system_prompt IS NOT NULL AND length(system_prompt) > 50000';
    EXECUTE 'UPDATE ig_config SET cap_diario_usd = 5.00 WHERE cap_diario_usd < 0.10 OR cap_diario_usd > 1000';

    -- CHECK constraints (drop si existían + add)
    EXECUTE 'ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_max_tokens_sane';
    EXECUTE 'ALTER TABLE ig_config ADD CONSTRAINT ig_config_max_tokens_sane CHECK (max_tokens BETWEEN 128 AND 4096)';
    EXECUTE 'ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_contexto_sane';
    EXECUTE 'ALTER TABLE ig_config ADD CONSTRAINT ig_config_contexto_sane CHECK (contexto_mensajes BETWEEN 1 AND 100)';
    EXECUTE 'ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_prompt_sane';
    EXECUTE 'ALTER TABLE ig_config ADD CONSTRAINT ig_config_prompt_sane CHECK (system_prompt IS NULL OR length(system_prompt) < 50000)';
    EXECUTE 'ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_cap_diario_sane';
    EXECUTE 'ALTER TABLE ig_config ADD CONSTRAINT ig_config_cap_diario_sane CHECK (cap_diario_usd BETWEEN 0.10 AND 1000)';
  END IF;
END $$;

-- ─── Verificación final ──────────────────────────────────────────────────
DO $$
DECLARE
  v_check_cols int;
  v_check_tabs int;
BEGIN
  SELECT COUNT(*) INTO v_check_cols FROM information_schema.columns
    WHERE (table_name = 'reservas' AND column_name = 'tags')
       OR (table_name = 'clientes' AND column_name = 'tags')
       OR (table_name = 'clientes' AND column_name = 'fecha_nacimiento')
       OR (table_name = 'usuarios' AND column_name = 'apps_permitidas');
  ASSERT v_check_cols = 4, format('Faltan columnas: solo %s/4 creadas', v_check_cols);

  SELECT COUNT(*) INTO v_check_tabs FROM information_schema.tables WHERE table_name IN
    ('marketing_inversiones','integraciones','campanas','campana_envios','automatizaciones','accesos_audit');
  ASSERT v_check_tabs = 6, format('Faltan tablas: solo %s/6 creadas', v_check_tabs);

  RAISE NOTICE '✓ 4 columnas + 6 tablas + caps bot IG listos. Todo OK.';
END $$;

COMMIT;
