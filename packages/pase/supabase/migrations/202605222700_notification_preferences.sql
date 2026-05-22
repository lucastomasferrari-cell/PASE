-- ═══════════════════════════════════════════════════════════════════════════
-- Notification preferences por user
--
-- Lucas 2026-05-22 noche: "estaria bueno que podamos mandar mas notificaciones
-- no solo estas, podriamos tener en configuracion una parte donde definimos
-- que notificaciones queremos recibir".
--
-- Tipos iniciales (constantes en `src/lib/notification-types.ts`):
--   - ig_dm_new              → DM nuevo a Instagram (ya implementado en bot)
--   - marketplace_order_new  → Pedido nuevo en tienda online (pendiente wirear)
--   - ig_escalation_human    → Cliente IG pidió hablar con humano (pendiente)
--   - cashbox_negative       → Saldo caja física negativo al cierre (pendiente)
--   - daily_closing_summary  → Resumen diario al cierre del día (pendiente)
--
-- Default: si NO existe fila → notificación HABILITADA (opt-out, no opt-in).
-- Esto evita que un user que recién instala el bot no reciba nada por no
-- haber tocado la pantalla. Si el user explícitamente desactiva, queda
-- enabled=false y respetamos su decisión.
--
-- Las preferences son globales por user (no por device) — si el user
-- desactiva ig_dm_new, no le llega ni al celu ni a la compu. La granularidad
-- por device se podrá agregar a futuro guardando preferences (user_id, type,
-- subscription_id) en lugar de (user_id, type).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notification_preferences (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  notification_type  TEXT NOT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notif_prefs_user_type_unique UNIQUE (user_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_notif_prefs_user
  ON notification_preferences (user_id);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION fn_notif_prefs_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_prefs_touch_updated_at ON notification_preferences;
CREATE TRIGGER trg_notif_prefs_touch_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION fn_notif_prefs_touch_updated_at();

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- Cada user maneja SUS propias preferences. RLS dual: authenticated solo
-- las suyas; service_role bypassa (el bot las lee para decidir si manda).
DROP POLICY IF EXISTS notif_prefs_select ON notification_preferences;
CREATE POLICY notif_prefs_select ON notification_preferences
  FOR SELECT
  TO authenticated
  USING (user_id = auth_usuario_id());

DROP POLICY IF EXISTS notif_prefs_insert ON notification_preferences;
CREATE POLICY notif_prefs_insert ON notification_preferences
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth_usuario_id());

DROP POLICY IF EXISTS notif_prefs_update ON notification_preferences;
CREATE POLICY notif_prefs_update ON notification_preferences
  FOR UPDATE
  TO authenticated
  USING (user_id = auth_usuario_id())
  WITH CHECK (user_id = auth_usuario_id());

DROP POLICY IF EXISTS notif_prefs_delete ON notification_preferences;
CREATE POLICY notif_prefs_delete ON notification_preferences
  FOR DELETE
  TO authenticated
  USING (user_id = auth_usuario_id());

-- ─── Helper RPC: chequear si un user quiere recibir un tipo dado ─────────
-- Usado por el bot (service_role). Devuelve TRUE si:
--   - no hay fila → default ON
--   - hay fila con enabled = TRUE
-- Devuelve FALSE solo si el user explícitamente desactivó.
CREATE OR REPLACE FUNCTION fn_user_quiere_notif(
  p_user_id INTEGER,
  p_type    TEXT
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT enabled FROM notification_preferences
       WHERE user_id = p_user_id AND notification_type = p_type
       LIMIT 1),
    TRUE
  );
$$;

REVOKE ALL ON FUNCTION fn_user_quiere_notif(INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_user_quiere_notif(INTEGER, TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
