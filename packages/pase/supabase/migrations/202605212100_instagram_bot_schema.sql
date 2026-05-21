-- ═══════════════════════════════════════════════════════════════════════════
-- Schema base del bot de Instagram para PASE
--
-- Visión Lucas 2026-05-20: reemplazar ManyChat con un bot custom que use
-- Claude + tools + memoria total. Atiende DMs de Instagram con contexto
-- de toda la conversación previa + datos del negocio (menú, reservas,
-- horarios, clientes históricos).
--
-- Tablas:
--   ig_config          - configuración por tenant (page_access_token, etc.)
--   ig_clientes        - el cliente que escribe (1 por igsid)
--   ig_conversaciones  - thread (1 por par tenant+cliente)
--   ig_mensajes        - mensajes individuales (in/out)
--   ig_eventos         - log de webhooks recibidos + tool calls (audit)
--
-- Multi-tenant: cada cuenta de IG está atada a un tenant. Cuando llega un
-- mensaje a través del webhook, identificamos el tenant por ig_account_id.
--
-- RLS: solo dueño/admin/soporte del tenant puede ver sus conversaciones.
-- El webhook corre con SUPABASE_SERVICE_KEY (bypassa RLS) y filtra
-- manualmente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Configuración del bot por tenant ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ig_config (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- ID de la cuenta de Instagram Business (numérico largo de Meta)
  ig_account_id       TEXT NOT NULL UNIQUE,
  -- Nombre visible del negocio en IG (para system prompt)
  ig_username         TEXT,
  -- Token de acceso de la página de FB conectada a IG. Encriptado a
  -- nivel aplicación cuando se guarda (igual que mp_credenciales).
  page_access_token   TEXT NOT NULL,
  -- Bot encendido/apagado. Si false, el webhook guarda mensajes pero
  -- no responde — útil para dueño que toma manualmente sin sacar el bot
  -- de servicio.
  bot_activo          BOOLEAN NOT NULL DEFAULT TRUE,
  -- System prompt custom del negocio. Si NULL, usa el genérico de Neko.
  system_prompt       TEXT,
  -- Modelo de Claude a usar. Default Haiku (más barato, suficiente para
  -- la mayoría de respuestas).
  modelo              TEXT NOT NULL DEFAULT 'claude-haiku-4-6',
  -- Máximo de tokens por respuesta del LLM.
  max_tokens          INTEGER NOT NULL DEFAULT 1024,
  -- Cuántos mensajes históricos mandar al LLM como contexto.
  contexto_mensajes   INTEGER NOT NULL DEFAULT 30,
  -- Auto-disable si supera N respuestas en X minutos (anti-loop / anti-spam)
  rate_limit_msgs     INTEGER DEFAULT 30,
  rate_limit_minutos  INTEGER DEFAULT 5,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  created_by          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ig_config_account ON ig_config(ig_account_id);

ALTER TABLE ig_config ENABLE ROW LEVEL SECURITY;
-- Solo dueño/admin/superadmin del tenant ven config (incluye el token)
CREATE POLICY ig_config_select ON ig_config FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());
CREATE POLICY ig_config_write ON ig_config FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());
-- service_role full access (webhook)
CREATE POLICY ig_config_service ON ig_config FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);


-- ─── 2. Clientes IG ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ig_clientes (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- IGSID = Instagram-scoped user ID. Único POR tenant (el mismo usuario
  -- que le escribe a 2 cuentas IG distintas son 2 IGSIDs distintos).
  igsid               TEXT NOT NULL,
  -- Datos que el bot va a ir aprendiendo del cliente y guardando
  nombre              TEXT,
  telefono            TEXT,
  email               TEXT,
  -- Cosas relevantes para la operación (sin sobre-fitting):
  alergias            TEXT,
  preferencias        TEXT,       -- "le gusta el spicy", "vegana", etc.
  notas_internas      TEXT,       -- notas del dueño que NO se le muestran
  -- Anti-spam / control
  bloqueado           BOOLEAN NOT NULL DEFAULT FALSE,
  bloqueado_motivo    TEXT,
  -- Tracking
  primera_interaccion TIMESTAMPTZ DEFAULT NOW(),
  ultima_interaccion  TIMESTAMPTZ DEFAULT NOW(),
  mensajes_count      INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, igsid)
);

CREATE INDEX IF NOT EXISTS idx_ig_clientes_tenant
  ON ig_clientes(tenant_id, ultima_interaccion DESC);
CREATE INDEX IF NOT EXISTS idx_ig_clientes_telefono
  ON ig_clientes(tenant_id, telefono) WHERE telefono IS NOT NULL;

ALTER TABLE ig_clientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ig_clientes_select ON ig_clientes FOR SELECT TO authenticated
  USING (
    tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR auth_tiene_permiso('soporte')
    )
  );
CREATE POLICY ig_clientes_write ON ig_clientes FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());
CREATE POLICY ig_clientes_service ON ig_clientes FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);


-- ─── 3. Conversaciones (threads) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ig_conversaciones (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cliente_id          BIGINT NOT NULL REFERENCES ig_clientes(id) ON DELETE CASCADE,
  -- Estado de la conversación
  estado              TEXT NOT NULL DEFAULT 'bot'
    CHECK (estado IN (
      'bot',         -- atendida por el bot
      'humano',      -- un agente humano la tomó
      'escalada',    -- bot escaló a humano vía tool derivar_a_humano
      'cerrada',     -- terminada
      'spam'         -- marcada como spam, no responder
    )),
  -- Cuando un humano la toma, dejamos el rastro de quién y cuándo
  tomada_por          INTEGER REFERENCES usuarios(id),
  tomada_at           TIMESTAMPTZ,
  -- Si el bot la escaló, esto apunta al ticket de Soporte que creó
  ticket_soporte_id   UUID,
  escalada_motivo     TEXT,
  -- Resumen últimos mensajes (denormalizado, para la lista de admin)
  ultimo_mensaje_at   TIMESTAMPTZ DEFAULT NOW(),
  ultimo_mensaje_preview TEXT,
  no_leidos_admin     INTEGER DEFAULT 0,
  -- Audit
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, cliente_id)
);

CREATE INDEX IF NOT EXISTS idx_ig_conv_recientes
  ON ig_conversaciones(tenant_id, ultimo_mensaje_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_conv_pendientes
  ON ig_conversaciones(tenant_id, estado, ultimo_mensaje_at DESC)
  WHERE estado IN ('escalada', 'humano');

ALTER TABLE ig_conversaciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY ig_conv_select ON ig_conversaciones FOR SELECT TO authenticated
  USING (
    tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR auth_tiene_permiso('soporte')
    )
  );
CREATE POLICY ig_conv_write ON ig_conversaciones FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());
CREATE POLICY ig_conv_service ON ig_conversaciones FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);


-- ─── 4. Mensajes individuales ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ig_mensajes (
  id                  BIGSERIAL PRIMARY KEY,
  conversacion_id     BIGINT NOT NULL REFERENCES ig_conversaciones(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Dirección
  direccion           TEXT NOT NULL CHECK (direccion IN ('in', 'out')),
  -- Quién mandó: cliente, bot, humano
  origen              TEXT NOT NULL CHECK (origen IN ('cliente', 'bot', 'humano')),
  -- Si origen='humano', quién (usuario interno)
  usuario_id          INTEGER REFERENCES usuarios(id),
  -- Contenido — pueden ser distintos tipos
  tipo                TEXT NOT NULL DEFAULT 'texto'
    CHECK (tipo IN ('texto', 'imagen', 'audio', 'video', 'sticker', 'reaccion', 'reply', 'unsupported')),
  texto               TEXT,
  media_url           TEXT,         -- si tipo no es texto
  -- Si el bot llamó tools en este turno, guardamos qué hizo
  tools_llamadas      JSONB,
  -- ID del mensaje en Meta (para deduplicación + responder con quote_id)
  ig_mid              TEXT,
  -- Costo del LLM en este turno (input_tokens + output_tokens + USD aprox)
  llm_tokens_in       INTEGER,
  llm_tokens_out      INTEGER,
  llm_cost_usd        NUMERIC(10, 6),
  -- Marca de error si el bot falló al responder este mensaje
  error               TEXT,
  -- Tracking
  created_at          TIMESTAMPTZ DEFAULT NOW(),

  -- Deduplicación: el mismo mid de Meta no se guarda dos veces
  UNIQUE (tenant_id, ig_mid)
);

CREATE INDEX IF NOT EXISTS idx_ig_msgs_conv
  ON ig_mensajes(conversacion_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ig_msgs_tenant_recent
  ON ig_mensajes(tenant_id, created_at DESC);

ALTER TABLE ig_mensajes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ig_msgs_select ON ig_mensajes FOR SELECT TO authenticated
  USING (
    tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR auth_tiene_permiso('soporte')
    )
  );
CREATE POLICY ig_msgs_write ON ig_mensajes FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());
CREATE POLICY ig_msgs_service ON ig_mensajes FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);


-- ─── 5. Eventos / audit log (webhooks recibidos, tools ejecutadas, etc.) ──
-- Esta tabla es importante para debugging y para entender qué hizo el bot
-- cuando algo falla. Nada confidencial — solo metadata.
CREATE TABLE IF NOT EXISTS ig_eventos (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID,  -- puede ser NULL si llegó un webhook sin tenant identificable
  conversacion_id     BIGINT REFERENCES ig_conversaciones(id) ON DELETE SET NULL,
  tipo                TEXT NOT NULL,  -- 'webhook_received', 'tool_called', 'message_sent', 'error', 'rate_limit', etc.
  payload             JSONB,
  error_message       TEXT,
  duracion_ms         INTEGER,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ig_eventos_tenant_recent
  ON ig_eventos(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_eventos_errores
  ON ig_eventos(tenant_id, created_at DESC) WHERE tipo = 'error';

ALTER TABLE ig_eventos ENABLE ROW LEVEL SECURITY;
CREATE POLICY ig_eventos_select ON ig_eventos FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());
CREATE POLICY ig_eventos_service ON ig_eventos FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);


-- ─── 6. Triggers updated_at ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_ig_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS ig_config_updated_at ON ig_config;
CREATE TRIGGER ig_config_updated_at BEFORE UPDATE ON ig_config
  FOR EACH ROW EXECUTE FUNCTION trg_ig_updated_at();

DROP TRIGGER IF EXISTS ig_clientes_updated_at ON ig_clientes;
CREATE TRIGGER ig_clientes_updated_at BEFORE UPDATE ON ig_clientes
  FOR EACH ROW EXECUTE FUNCTION trg_ig_updated_at();

DROP TRIGGER IF EXISTS ig_conv_updated_at ON ig_conversaciones;
CREATE TRIGGER ig_conv_updated_at BEFORE UPDATE ON ig_conversaciones
  FOR EACH ROW EXECUTE FUNCTION trg_ig_updated_at();

-- Auto-update de ig_conversaciones.ultimo_mensaje_* y ig_clientes.ultima_interaccion
-- cuando llega un mensaje nuevo.
CREATE OR REPLACE FUNCTION fn_trg_ig_msg_actualiza_conv()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ig_conversaciones SET
    ultimo_mensaje_at = NEW.created_at,
    ultimo_mensaje_preview = LEFT(COALESCE(NEW.texto, '[' || NEW.tipo || ']'), 200),
    -- Si el mensaje es del cliente (in), incrementar contador de no_leidos_admin
    no_leidos_admin = CASE
      WHEN NEW.direccion = 'in' THEN no_leidos_admin + 1
      ELSE no_leidos_admin
    END,
    updated_at = NOW()
  WHERE id = NEW.conversacion_id;

  -- Actualizar el cliente
  UPDATE ig_clientes c SET
    ultima_interaccion = NEW.created_at,
    mensajes_count = mensajes_count + 1,
    updated_at = NOW()
  FROM ig_conversaciones conv
  WHERE conv.id = NEW.conversacion_id AND c.id = conv.cliente_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ig_msg_actualiza_conv ON ig_mensajes;
CREATE TRIGGER trg_ig_msg_actualiza_conv
  AFTER INSERT ON ig_mensajes
  FOR EACH ROW EXECUTE FUNCTION fn_trg_ig_msg_actualiza_conv();


-- ─── 7. View helper: conversaciones con info para lista de admin ──────────
CREATE OR REPLACE VIEW v_ig_conversaciones_admin
WITH (security_invoker = on) AS
SELECT
  c.id,
  c.tenant_id,
  c.estado,
  c.tomada_por,
  c.tomada_at,
  c.ticket_soporte_id,
  c.escalada_motivo,
  c.ultimo_mensaje_at,
  c.ultimo_mensaje_preview,
  c.no_leidos_admin,
  c.created_at,
  cli.id AS cliente_id,
  cli.igsid,
  cli.nombre AS cliente_nombre,
  cli.telefono AS cliente_telefono,
  cli.mensajes_count,
  cli.primera_interaccion,
  cli.bloqueado,
  u.nombre AS tomada_por_nombre
FROM ig_conversaciones c
JOIN ig_clientes cli ON cli.id = c.cliente_id
LEFT JOIN usuarios u ON u.id = c.tomada_por;

GRANT SELECT ON v_ig_conversaciones_admin TO authenticated;

NOTIFY pgrst, 'reload schema';
