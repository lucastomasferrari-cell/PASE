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

-- ─── 6) Realtime mesas: publication para que el POS sincronice mesas ────
-- Migración 202605101100. Habilita Supabase Realtime en tablas críticas
-- (incluye `mesas`) para sincronizar updates entre dispositivos sin polling.
-- Idempotente: si ya está, skip.
DO $$
DECLARE
  tables TEXT[] := ARRAY['mesas','ventas_pos','ventas_pos_items','ventas_pos_pagos','turnos_caja','movimientos_caja','metodos_cobro','comanda_local_settings'];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ─── 7) Hub credenciales: extender tabla integraciones ──────────────────
-- Permite cargar tokens de WhatsApp/Email/Stripe/etc por tenant desde la UI.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'integraciones') THEN
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS ultima_verificacion_at TIMESTAMPTZ';
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS ultimo_error TEXT';
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS notas TEXT';
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS updated_by INTEGER';
    EXECUTE 'ALTER TABLE integraciones DROP CONSTRAINT IF EXISTS integraciones_provider_check';
    EXECUTE $C$ALTER TABLE integraciones ADD CONSTRAINT integraciones_provider_check CHECK (provider IN ('whatsapp_api','email','meta_ads','google_ads','search_console','instagram','google_maps','stripe','mp_point'))$C$;
    EXECUTE 'ALTER TABLE integraciones DROP CONSTRAINT IF EXISTS integraciones_estado_check';
    EXECUTE $C$ALTER TABLE integraciones ADD CONSTRAINT integraciones_estado_check CHECK (estado IN ('desconectado','conectado','error','probando'))$C$;
  END IF;
END $$;

-- ─── 8) Conciliación caja con diferencias + RPC + vista ────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'partes_operativos') THEN
    EXECUTE 'ALTER TABLE partes_operativos ADD COLUMN IF NOT EXISTS declarado_efectivo NUMERIC(14,2)';
    EXECUTE 'ALTER TABLE partes_operativos ADD COLUMN IF NOT EXISTS sistema_efectivo NUMERIC(14,2)';
    EXECUTE 'ALTER TABLE partes_operativos ADD COLUMN IF NOT EXISTS diferencia NUMERIC(14,2)';
    EXECUTE 'ALTER TABLE partes_operativos ADD COLUMN IF NOT EXISTS diferencia_justificacion TEXT';
    EXECUTE 'ALTER TABLE partes_operativos ADD COLUMN IF NOT EXISTS diferencia_aceptada_por TEXT';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_cuadre_caja(
  p_turno_id INTEGER, p_declarado_efectivo NUMERIC,
  p_justificacion TEXT DEFAULT NULL, p_aceptado_por TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $F$
DECLARE v_local_id INTEGER; v_tenant_id TEXT; v_sistema NUMERIC := 0; v_diferencia NUMERIC; v_parte_id BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT t.local_id, l.tenant_id::TEXT INTO v_local_id, v_tenant_id
    FROM turnos_caja t JOIN locales l ON l.id = t.local_id WHERE t.id = p_turno_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'TURNO_NO_ENCONTRADO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_ACCESO_AL_LOCAL';
  END IF;
  SELECT COALESCE(SUM(monto), 0) INTO v_sistema FROM movimientos_caja
    WHERE turno_id = p_turno_id AND metodo_cobro = 'efectivo';
  v_diferencia := p_declarado_efectivo - v_sistema;
  SELECT id INTO v_parte_id FROM partes_operativos WHERE turno_id = p_turno_id;
  IF v_parte_id IS NOT NULL THEN
    UPDATE partes_operativos SET declarado_efectivo = p_declarado_efectivo, sistema_efectivo = v_sistema,
      diferencia = v_diferencia, diferencia_justificacion = p_justificacion,
      diferencia_aceptada_por = p_aceptado_por WHERE id = v_parte_id;
  ELSE
    INSERT INTO partes_operativos (tenant_id, local_id, turno_id, declarado_efectivo, sistema_efectivo,
      diferencia, diferencia_justificacion, diferencia_aceptada_por)
    VALUES (v_tenant_id, v_local_id, p_turno_id, p_declarado_efectivo, v_sistema, v_diferencia,
      p_justificacion, p_aceptado_por) RETURNING id INTO v_parte_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'parte_id', v_parte_id, 'sistema', v_sistema,
    'declarado', p_declarado_efectivo, 'diferencia', v_diferencia,
    'estado', CASE WHEN ABS(v_diferencia) < 1 THEN 'cuadra' WHEN v_diferencia > 0 THEN 'sobra' ELSE 'falta' END);
END $F$;
GRANT EXECUTE ON FUNCTION fn_cuadre_caja(INTEGER, NUMERIC, TEXT, TEXT) TO authenticated;

-- ─── 9) tenant_subscriptions: campos Stripe ─────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_subscriptions') THEN
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT';
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT';
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id TEXT';
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT';
  END IF;
END $$;

-- ─── 10) Descuentos públicos para marketplace (RPC) ────────────────────
CREATE OR REPLACE FUNCTION fn_descuentos_publicos_tienda(p_local_slug TEXT)
RETURNS TABLE (
  code TEXT, descripcion TEXT, tipo TEXT, valor NUMERIC,
  monto_min_compra NUMERIC, fecha_hasta TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $D$
DECLARE v_local_id INTEGER;
BEGIN
  SELECT cls.local_id INTO v_local_id FROM comanda_local_settings cls
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT c.code, c.descripcion, c.tipo, c.valor, c.monto_min_compra, c.fecha_hasta
    FROM cupones c
    WHERE c.activo = TRUE AND c.deleted_at IS NULL
      AND (c.local_id = v_local_id OR c.local_id IS NULL)
      AND (c.fecha_desde IS NULL OR c.fecha_desde <= NOW())
      AND (c.fecha_hasta IS NULL OR c.fecha_hasta >= NOW())
      AND (c.max_usos IS NULL OR c.usos_actuales < c.max_usos)
      AND (c.canales_aplicables IS NULL OR 'tienda_online' = ANY(c.canales_aplicables))
      AND COALESCE(c.solo_primera_compra, FALSE) = FALSE
    ORDER BY CASE WHEN c.tipo = 'porcentaje' THEN c.valor ELSE 0 END DESC,
             CASE WHEN c.tipo = 'monto_fijo' THEN c.valor ELSE 0 END DESC
    LIMIT 10;
END $D$;
REVOKE ALL ON FUNCTION fn_descuentos_publicos_tienda(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_descuentos_publicos_tienda(TEXT) TO anon, authenticated;

-- ─── 11) Vista costo IG diario por tenant (admin-console) ────────────────
-- Mostrar gasto del bot IG por tenant en Tenants.tsx + alerta si se acerca al cap.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ig_config')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ig_mensajes') THEN
    EXECUTE $V$
      CREATE OR REPLACE VIEW v_ig_costo_diario_tenant AS
      SELECT
        c.tenant_id,
        COALESCE(MAX(c.cap_diario_usd), 5.00) AS cap_diario_usd,
        COALESCE(SUM(
          CASE WHEN m.created_at >= CURRENT_DATE THEN m.llm_cost_usd ELSE 0 END
        ), 0)::NUMERIC(10,4) AS gasto_hoy_usd,
        COALESCE(SUM(
          CASE WHEN m.created_at >= CURRENT_DATE - INTERVAL '7 days' THEN m.llm_cost_usd ELSE 0 END
        ), 0)::NUMERIC(10,4) AS gasto_7d_usd,
        COUNT(*) FILTER (
          WHERE m.created_at >= CURRENT_DATE AND m.direccion = 'out' AND m.origen = 'bot'
        ) AS mensajes_hoy
      FROM ig_config c
      LEFT JOIN ig_mensajes m ON m.tenant_id = c.tenant_id
      GROUP BY c.tenant_id
    $V$;
    EXECUTE 'REVOKE ALL ON v_ig_costo_diario_tenant FROM PUBLIC';
    EXECUTE 'GRANT SELECT ON v_ig_costo_diario_tenant TO authenticated';
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
