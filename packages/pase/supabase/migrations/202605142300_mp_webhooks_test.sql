-- ═══════════════════════════════════════════════════════════════════════════
-- TABLA OBSERVATORIO: mp_webhooks_test
--
-- Origen: Lucas pidió 2026-05-14 probar si los webhooks de MP traen pagos
--         que el cron actual (release_report + payments/search cada 30min)
--         pierde — específicamente Point Smart, donde se documentó faltante
--         de ~$553k el 1/5.
--
-- Diseño:
--   • OBSERVATORIO PURO: NO toca mp_movimientos, mp_credenciales, ni nada
--     de producción. Cada webhook recibido se guarda crudo + se hace lookup
--     contra mp_movimientos para ver si ya existía.
--   • SCOPE INICIAL: solo Neko Villa Crespo. El endpoint identifica el local
--     en runtime por nombre ILIKE '%villa crespo%' y rechaza cualquier
--     webhook que no matchee.
--   • DELETABLE: si el experimento no funciona, DROP TABLE mp_webhooks_test
--     + delete del endpoint + del sidebar item, sin impacto en producción.
--
-- Uso esperado:
--   1. Lucas configura webhook en panel MP → URL del endpoint nuevo.
--   2. MP empieza a mandar notificaciones (payment.created, payment.updated).
--   3. El endpoint guarda cada notif acá + intenta GET /v1/payments/{id}.
--   4. La página WebhooksMpTest.tsx muestra el feed en vivo + cruce con
--      mp_movimientos para ver qué webhooks SÍ trae el cron y cuáles NO.
--
-- Convenciones CLAUDE.md:
--   • C7 — columnas estándar tenant_id, created_at, updated_at, RLS dual.
--   • RLS: SELECT abierto a authenticated del tenant; INSERT solo
--     service_role (el endpoint usa SUPABASE_SERVICE_KEY).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mp_webhooks_test (
  -- ID interno UUID (no usamos un id de MP — un mismo payment_id puede
  -- generar N webhooks distintos: created, updated, refund, etc).
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant + scope (CLAUDE.md C3/C7).
  tenant_id          uuid REFERENCES tenants(id),
  local_id           integer REFERENCES locales(id),
  mp_credencial_id   integer REFERENCES mp_credenciales(id),

  -- Timing.
  received_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Datos del request entrante (raw, sin procesar).
  http_signature_header  text,
  http_request_id        text,
  http_signature_valid   boolean,
  http_signature_error   text,
  raw_body               jsonb NOT NULL,

  -- Campos extraídos del payload de notificación (top-level shape MP).
  -- mp_topic = 'payment' | 'merchant_order' | etc. (campo "topic" o "type").
  -- mp_resource_id = el id que MP nos manda (típicamente data.id).
  mp_topic           text,
  mp_action          text,             -- 'payment.created' | 'payment.updated' | null
  mp_resource_id     text,             -- id que viene en data.id (string)
  mp_user_id         text,             -- user_id del receptor (si viene)

  -- Resultado del GET /v1/payments/{id} disparado por el endpoint.
  payment_fetched_at      timestamptz,
  payment_fetch_status    integer,     -- 200 | 401 | 404 | etc
  payment_fetch_error     text,
  payment_data            jsonb,       -- response completo de MP, si 200

  -- Cruce con mp_movimientos al momento de recibir el webhook.
  -- 'already_in_mov' = el payment_id ya estaba en mp_movimientos.
  -- 'not_in_mov'     = NO estaba (CASO INTERESANTE — webhook trajo algo nuevo).
  -- 'mov_check_err'  = error al consultar.
  -- 'no_payment_id'  = el webhook no trae payment_id chequeable.
  match_status            text,
  match_mp_movimiento_id  text,        -- id de mp_movimientos si matchea
  match_checked_at        timestamptz
);

-- ─── Índices ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mp_webhooks_test_received_at
  ON mp_webhooks_test (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_webhooks_test_tenant_local
  ON mp_webhooks_test (tenant_id, local_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_webhooks_test_resource
  ON mp_webhooks_test (mp_resource_id);
CREATE INDEX IF NOT EXISTS idx_mp_webhooks_test_match
  ON mp_webhooks_test (match_status, received_at DESC);

-- ─── Trigger updated_at ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_mp_webhooks_test_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mp_webhooks_test_updated_at ON mp_webhooks_test;
CREATE TRIGGER trg_mp_webhooks_test_updated_at
  BEFORE UPDATE ON mp_webhooks_test
  FOR EACH ROW EXECUTE FUNCTION fn_mp_webhooks_test_updated_at();

-- ─── RLS dual (auth + service) ──────────────────────────────────────────────
ALTER TABLE mp_webhooks_test ENABLE ROW LEVEL SECURITY;

-- SELECT: usuarios authenticated del mismo tenant + superadmin.
DROP POLICY IF EXISTS "mp_webhooks_test_select" ON mp_webhooks_test;
CREATE POLICY "mp_webhooks_test_select" ON mp_webhooks_test
  FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR tenant_id = auth_tenant_id()
  );

-- INSERT/UPDATE/DELETE: solo service_role (el endpoint con SERVICE_KEY).
DROP POLICY IF EXISTS "mp_webhooks_test_service" ON mp_webhooks_test;
CREATE POLICY "mp_webhooks_test_service" ON mp_webhooks_test
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Permission en MODULOS (registro lógico) ────────────────────────────────
-- El slug 'webhooks_mp_test' se agrega a auth.ts MODULOS y a sidebar-nav.ts.
-- Por default solo dueno/admin/superadmin lo ven (gate en frontend).

COMMENT ON TABLE mp_webhooks_test IS
  'Observatorio temporal: cada webhook de MP recibido + lookup contra mp_movimientos. NO toca producción. Borrable si el experimento falla. Origen: Lucas 2026-05-14, hipótesis webhooks resuelven shard inconsistency + Point Smart faltante.';
