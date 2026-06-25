-- ═══════════════════════════════════════════════════════════════════════════
-- Habitué — motor de marketing (integraciones + campañas + automatizaciones)
-- 25-jun-2026
--
-- Deja LISTO el modelo de datos para que conectar las APIs (WhatsApp Business,
-- email, Meta/Google Ads, Search Console) y prender las automatizaciones sea
-- SOLO poner el código de integración. Todo aditivo y con RLS por tenant.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cumpleaños del comensal (para automatización de saludo) ──────────────────
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE;

-- ── Config de integraciones externas (tokens / estado por provider) ──────────
CREATE TABLE IF NOT EXISTS integraciones (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  provider     TEXT        NOT NULL,         -- whatsapp_api / email / meta_ads / google_ads / search_console / instagram
  estado       TEXT        NOT NULL DEFAULT 'desconectado',  -- desconectado / conectado / error
  config       JSONB       NOT NULL DEFAULT '{}'::jsonb,      -- credenciales/ids (server-side)
  conectado_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

-- ── Campañas (persistentes + stats para attribution) ─────────────────────────
CREATE TABLE IF NOT EXISTS campanas (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  nombre          TEXT        NOT NULL,
  canal           TEXT        NOT NULL,       -- whatsapp / email / sms
  segmento_key    TEXT,                       -- segmento usado (perdidos, vip, etc.)
  mensaje         TEXT        NOT NULL,
  cupon_id        BIGINT,                     -- cupón adjunto opcional
  estado          TEXT        NOT NULL DEFAULT 'borrador', -- borrador / programada / enviando / enviada
  programada_para TIMESTAMPTZ,
  destinatarios   INTEGER     NOT NULL DEFAULT 0,
  enviados        INTEGER     NOT NULL DEFAULT 0,
  abiertos        INTEGER     NOT NULL DEFAULT 0,
  conversiones    INTEGER     NOT NULL DEFAULT 0,  -- volvieron/compraron tras la campaña
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

-- ── Envíos por destinatario (el log que habilita attribution real) ───────────
CREATE TABLE IF NOT EXISTS campana_envios (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campana_id  BIGINT      NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  tenant_id   TEXT        NOT NULL,
  cliente_id  BIGINT,                         -- sin FK dura: best-effort
  canal       TEXT        NOT NULL,
  destino     TEXT,                           -- teléfono o email
  estado      TEXT        NOT NULL DEFAULT 'pendiente', -- pendiente/enviado/error/abierto/convertido
  enviado_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Automatizaciones (flows lifecycle) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS automatizaciones (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  nombre          TEXT        NOT NULL,
  trigger_tipo    TEXT        NOT NULL,       -- sin_pedir_dias / cumpleanos / primera_compra / post_visita / recurrente
  trigger_params  JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- ej {dias:60}
  accion_tipo     TEXT        NOT NULL,       -- enviar_campana / dar_cupon
  accion_params   JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- ej {canal:whatsapp, mensaje, cupon_id}
  activa          BOOLEAN     NOT NULL DEFAULT FALSE,
  ultima_corrida_at TIMESTAMPTZ,
  disparos        INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

-- ── RLS (todo por tenant) ────────────────────────────────────────────────────
ALTER TABLE integraciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE campana_envios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE automatizaciones  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "integraciones_by_tenant" ON integraciones FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
CREATE POLICY "campanas_by_tenant" ON campanas FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
CREATE POLICY "campana_envios_by_tenant" ON campana_envios FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);
CREATE POLICY "automatizaciones_by_tenant" ON automatizaciones FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()::text) WITH CHECK (tenant_id = auth_tenant_id()::text);

CREATE INDEX IF NOT EXISTS campanas_tenant_idx ON campanas (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS campana_envios_campana_idx ON campana_envios (campana_id);
CREATE INDEX IF NOT EXISTS automatizaciones_tenant_idx ON automatizaciones (tenant_id) WHERE deleted_at IS NULL;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN
    ('integraciones','campanas','campana_envios','automatizaciones')) = 4,
    'faltan tablas del motor de marketing';
END;
$$;
