-- ═══════════════════════════════════════════════════════════════════════════
-- Push subscriptions: sin restricción de rol
--
-- Decisión Lucas 22-may noche: "cualquiera puede tener acceso a notificaciones
-- si tiene acceso a ese módulo, no tiene sentido limitarlo". El gate ya está
-- antes (el módulo Mensajería tiene su propio chequeo de permiso). Si el
-- user llegó a `/mensajeria`, puede suscribirse.
--
-- RLS sigue protegiendo:
-- - El user solo puede crear/leer/borrar SUS propias suscripciones
--   (user_id = auth_usuario_id())
-- - No puede ver subs de otros usuarios
-- - El bot (service_role) bypassa RLS para mandar el push
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS admin_push_subs_insert ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_insert ON admin_push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth_usuario_id());

DROP POLICY IF EXISTS admin_push_subs_select ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_select ON admin_push_subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = auth_usuario_id());

-- DELETE y UPDATE ya estaban abiertas al dueño de la sub. Sin cambios.

NOTIFY pgrst, 'reload schema';
