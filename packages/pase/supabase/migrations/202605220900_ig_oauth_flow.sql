-- ═══════════════════════════════════════════════════════════════════════════
-- OAuth flow para Instagram — onboarding multi-tenant en 1 click
--
-- Visión Lucas 2026-05-21: cada restaurante que use PASE va a poder
-- conectar su Instagram con un botón. El flow:
--   1. Click "Conectar Instagram" en PASE
--   2. PASE pide al bot un state token + redirect URL
--   3. Popup OAuth de Meta → el dueño selecciona su cuenta IG y autoriza
--   4. Meta redirige al callback del bot con code + state
--   5. Bot intercambia code por access_token long-lived (60 días)
--   6. Bot inserta/actualiza ig_config con el token + datos del IG
--   7. Bot suscribe la cuenta al webhook
--   8. PASE recibe confirmación y muestra "Conectado ✅"
--
-- También: auto-refresh de tokens antes de los 60 días para que la
-- conexión NUNCA se caiga sin avisar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Agregar columnas a ig_config para tracking del token ──────────────
ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS token_creado_at TIMESTAMPTZ;

ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS token_expira_at TIMESTAMPTZ;

ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS connected_by INTEGER REFERENCES usuarios(id);

ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS desconectado_at TIMESTAMPTZ;

-- Para tokens ya existentes (Neko), poblar token_expira_at asumiendo 60 días
-- desde la creación de la fila — para que el sistema de auto-refresh los tome.
UPDATE ig_config
  SET token_creado_at = COALESCE(token_creado_at, created_at),
      token_expira_at = COALESCE(token_expira_at, created_at + INTERVAL '60 days')
  WHERE token_creado_at IS NULL OR token_expira_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ig_config_expira
  ON ig_config(token_expira_at)
  WHERE bot_activo = TRUE AND desconectado_at IS NULL;

-- ─── 2. Tabla ig_oauth_states ─────────────────────────────────────────────
-- Cuando PASE inicia el OAuth flow, genera un state aleatorio y lo guarda
-- acá con el tenant_id + usuario_id. Cuando Meta redirige al callback con
-- ese state, validamos que exista + no esté consumido. Eso previene CSRF
-- (un atacante no puede iniciar un flow para otro tenant).
--
-- Los states expiran a los 15 min para limpiar (cron diario)

CREATE TABLE IF NOT EXISTS ig_oauth_states (
  state           TEXT PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id      INTEGER REFERENCES usuarios(id),
  -- Para volver al user a la URL que estaba (deep linking)
  return_url      TEXT,
  -- Si ya se consumió (callback procesado), no se puede usar de nuevo
  consumed        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Expira a los 15 min — el user tiene 15 min para completar el flow
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  consumed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expira
  ON ig_oauth_states(expires_at)
  WHERE consumed = FALSE;

ALTER TABLE ig_oauth_states ENABLE ROW LEVEL SECURITY;

-- service_role full access (el bot crea/lee states)
CREATE POLICY oauth_states_service ON ig_oauth_states FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- Authenticated solo puede ver sus propios states (para debugging desde PASE)
CREATE POLICY oauth_states_select_own ON ig_oauth_states FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());

-- ─── 3. RPC: iniciar OAuth flow desde PASE ────────────────────────────────
-- PASE llama esta RPC para generar el state + obtener la URL de autorización
-- de Instagram. El frontend abre esa URL en un popup.

CREATE OR REPLACE FUNCTION fn_ig_oauth_iniciar(
  p_return_url TEXT DEFAULT NULL
) RETURNS TABLE (
  state TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_state TEXT;
  v_expires_at TIMESTAMPTZ;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'SOLO_DUENO_O_ADMIN';
  END IF;

  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  -- Generar state aleatorio: 32 bytes en hex = 64 chars
  v_state := encode(gen_random_bytes(32), 'hex');
  v_expires_at := NOW() + INTERVAL '15 minutes';

  INSERT INTO ig_oauth_states (state, tenant_id, usuario_id, return_url, expires_at)
  VALUES (v_state, v_tenant_id, v_user_id, p_return_url, v_expires_at);

  RETURN QUERY SELECT v_state, v_expires_at;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_ig_oauth_iniciar(TEXT) TO authenticated;

-- ─── 4. View: estado de conexión por tenant ───────────────────────────────
-- Cuántos días faltan para que venza el token, estado del bot, etc.
-- Lo lee PASE para mostrar el panel de "Conexión Instagram".

CREATE OR REPLACE VIEW v_ig_conexion_estado
WITH (security_invoker = on) AS
SELECT
  c.tenant_id,
  c.ig_account_id,
  c.ig_username,
  c.bot_activo,
  c.created_at AS conectado_at,
  c.desconectado_at,
  c.token_creado_at,
  c.token_expira_at,
  c.connected_by,
  u.nombre AS connected_by_nombre,
  -- Días que faltan para que venza el token
  CASE
    WHEN c.token_expira_at IS NULL THEN NULL
    ELSE EXTRACT(DAY FROM c.token_expira_at - NOW())::INTEGER
  END AS dias_para_vencer,
  -- Estado simplificado para la UI
  CASE
    WHEN c.desconectado_at IS NOT NULL THEN 'desconectada'
    WHEN c.token_expira_at IS NULL THEN 'desconocido'
    WHEN c.token_expira_at < NOW() THEN 'vencida'
    WHEN c.token_expira_at < NOW() + INTERVAL '7 days' THEN 'por_vencer'
    ELSE 'conectada'
  END AS estado
FROM ig_config c
LEFT JOIN usuarios u ON u.id = c.connected_by;

GRANT SELECT ON v_ig_conexion_estado TO authenticated;

-- ─── 5. Cleanup automático de states expirados ────────────────────────────
-- Función helper que limpia states de >24h. La llama un cron job semanal.

CREATE OR REPLACE FUNCTION fn_cleanup_oauth_states() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_borrados INTEGER;
BEGIN
  DELETE FROM ig_oauth_states
  WHERE expires_at < NOW() - INTERVAL '24 hours';
  GET DIAGNOSTICS v_borrados = ROW_COUNT;
  RETURN v_borrados;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cleanup_oauth_states() TO service_role;

NOTIFY pgrst, 'reload schema';
