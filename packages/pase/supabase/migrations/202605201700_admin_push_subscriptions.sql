-- ═══════════════════════════════════════════════════════════════════════════
-- Web Push notifications para el Admin Console
--
-- Lucas 2026-05-19: cuando el auto-fix agent termina un PR (o falla), nos
-- llega notificación al celu para revisar/aprobar sin abrir la compu.
--
-- Tabla guarda las suscripciones del navegador (endpoint + claves de
-- cifrado). El workflow auto-fix-bug.yml las lee y envía push usando
-- scripts/send-push-to-superadmins.mjs (web-push library, RFC 8030).
--
-- Solo superadmins se suscriben (RLS). Los datos sensibles son claves
-- de cifrado, no credenciales — el riesgo en caso de leak es bajo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,                  -- URL única por device
  p256dh        TEXT NOT NULL,                  -- key cifrado del client
  auth          TEXT NOT NULL,                  -- secret cifrado del client
  device_label  TEXT,                           -- detect-from-UA opcional
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una suscripción es única por (user, endpoint). Si el user re-suscribe
  -- en el mismo device, hacemos upsert por endpoint.
  CONSTRAINT admin_push_subs_user_endpoint_unique UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_admin_push_subs_user
  ON admin_push_subscriptions (user_id, last_seen_at DESC);

ALTER TABLE admin_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- INSERT: solo el propio user (y solo si es superadmin) puede registrar
-- su suscripción.
DROP POLICY IF EXISTS admin_push_subs_insert ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_insert ON admin_push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth_usuario_id()
    AND auth_es_superadmin()
  );

-- SELECT: el propio user ve sus subs + service_role ve todas (para el sender).
DROP POLICY IF EXISTS admin_push_subs_select ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_select ON admin_push_subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = auth_usuario_id() AND auth_es_superadmin());

-- DELETE: el propio user puede borrar su suscripción (al desactivar
-- notificaciones desde la UI).
DROP POLICY IF EXISTS admin_push_subs_delete ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_delete ON admin_push_subscriptions
  FOR DELETE
  TO authenticated
  USING (user_id = auth_usuario_id());

-- UPDATE: solo last_seen_at (el cliente la actualiza periódicamente para
-- que sepamos qué subs están vivas).
DROP POLICY IF EXISTS admin_push_subs_update ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_update ON admin_push_subscriptions
  FOR UPDATE
  TO authenticated
  USING (user_id = auth_usuario_id())
  WITH CHECK (user_id = auth_usuario_id());

NOTIFY pgrst, 'reload schema';
