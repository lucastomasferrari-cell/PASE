-- Habitué — Marketing por email (Mailchimp propio) · FASE 1: modelo de datos
-- ---------------------------------------------------------------------------
-- Motor de envío + tracking: Resend (dominio mailing.comanda.lat). Habitué es la
-- plataforma (contactos, segmentos, campañas, plantillas, analítica, roles).
-- Resend maneja: entrega, unsubscribe (List-Unsubscribe + URL), open/click
-- tracking y webhooks de eventos → los guardamos en mkt_eventos.
--
-- Multi-tenant: todo lleva tenant_id + RLS (tenant_id = auth_tenant_id()). Sin
-- local_id (marketing es a nivel tenant, no por sucursal). Los endpoints usan
-- SUPABASE_SERVICE_KEY (bypass RLS, filtran manual) como el resto de Habitué.

-- ── 0) Opt-in / baja en clientes (compliance) ───────────────────────────────
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

-- ── 1) Config de remitente por tenant ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_config (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  from_nombre    text NOT NULL DEFAULT 'Neko',
  from_email     text NOT NULL DEFAULT 'hola@mailing.comanda.lat',
  reply_to       text,
  dominio_envio  text NOT NULL DEFAULT 'mailing.comanda.lat',
  resend_audience_id text,      -- opcional: audiencia espejo en Resend
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 2) Plantillas reutilizables ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_plantillas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre        text NOT NULL,
  asunto        text,
  html          text NOT NULL DEFAULT '',
  editor_json   jsonb,          -- estado del editor drag-drop (Fase editor)
  thumbnail_url text,
  archivada     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 3) Campañas ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_campanas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre          text NOT NULL,
  asunto          text NOT NULL DEFAULT '',
  preheader       text,
  from_nombre     text,
  from_email      text,
  reply_to        text,
  html            text NOT NULL DEFAULT '',
  editor_json     jsonb,
  segmento_nombre text,               -- etiqueta del segmento destino (UI)
  segmento_criterio jsonb,            -- filtro del segmento, congelado al enviar
  estado          text NOT NULL DEFAULT 'borrador'
    CHECK (estado IN ('borrador','programada','enviando','enviada','pausada','cancelada','error')),
  programada_para timestamptz,
  enviada_at      timestamptz,
  -- Rollup de métricas (actualizado por webhook; para dashboards rápidos).
  total_destinatarios integer NOT NULL DEFAULT 0,
  total_enviados      integer NOT NULL DEFAULT 0,
  total_entregados    integer NOT NULL DEFAULT 0,
  total_aperturas     integer NOT NULL DEFAULT 0,   -- únicas
  total_clicks        integer NOT NULL DEFAULT 0,   -- únicos
  total_rebotes       integer NOT NULL DEFAULT 0,
  total_quejas        integer NOT NULL DEFAULT 0,
  total_bajas         integer NOT NULL DEFAULT 0,
  ab_test            jsonb,                          -- config A/B (Fase A/B)
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_campanas_tenant_estado ON mkt_campanas (tenant_id, estado, created_at DESC);

-- ── 4) Destinatarios por campaña ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_campana_destinatarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campana_id    uuid NOT NULL REFERENCES mkt_campanas(id) ON DELETE CASCADE,
  cliente_id    bigint REFERENCES clientes(id) ON DELETE SET NULL,
  email         text NOT NULL,
  nombre        text,
  resend_email_id text,             -- id de Resend, para casar los webhooks
  estado        text NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','enviado','entregado','rebotado','fallido','suprimido')),
  abierto           boolean NOT NULL DEFAULT false,
  clickeado         boolean NOT NULL DEFAULT false,
  aperturas         integer NOT NULL DEFAULT 0,
  clicks            integer NOT NULL DEFAULT 0,
  primera_apertura_at timestamptz,
  ultimo_click_at     timestamptz,
  enviado_at    timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campana_id, email)
);
CREATE INDEX IF NOT EXISTS idx_mkt_dest_campana ON mkt_campana_destinatarios (campana_id, estado);
CREATE INDEX IF NOT EXISTS idx_mkt_dest_resend ON mkt_campana_destinatarios (resend_email_id) WHERE resend_email_id IS NOT NULL;

-- ── 5) Eventos (webhooks Resend) — log crudo para analítica ─────────────────
CREATE TABLE IF NOT EXISTS mkt_eventos (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campana_id    uuid REFERENCES mkt_campanas(id) ON DELETE CASCADE,
  destinatario_id uuid REFERENCES mkt_campana_destinatarios(id) ON DELETE CASCADE,
  email         text,
  tipo          text NOT NULL,   -- delivered/opened/clicked/bounced/complained/unsubscribed/failed
  url           text,            -- para clicks
  resend_email_id text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_eventos_campana_tipo ON mkt_eventos (campana_id, tipo, created_at DESC);

-- ── 6) Supresiones (do-not-send global por tenant) ──────────────────────────
CREATE TABLE IF NOT EXISTS mkt_supresiones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  motivo      text NOT NULL,     -- unsubscribe/bounce/complaint/manual
  campana_id  uuid REFERENCES mkt_campanas(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_mkt_supresiones_tenant_email ON mkt_supresiones (tenant_id, email);

-- ── RLS: acceso por tenant en todas las tablas nuevas ───────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mkt_config','mkt_plantillas','mkt_campanas',
                           'mkt_campana_destinatarios','mkt_eventos','mkt_supresiones']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t||'_tenant', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL TO authenticated
                      USING (tenant_id = auth_tenant_id())
                      WITH CHECK (tenant_id = auth_tenant_id())$p$, t||'_tenant', t);
  END LOOP;
END $$;
