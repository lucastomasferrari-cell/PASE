-- ═══════════════════════════════════════════════════════════════════════════
-- Push subscriptions: abrir a dueño + admin (no solo superadmin)
--
-- Pedido implícito Lucas 22-may noche: el botón "Activar notificaciones"
-- estaba limitado a superadmin pero Lucas opera de día como `dueno`.
-- También cuando vendamos PASE a otros restaurantes, sus dueños/admins
-- van a querer recibir push de SUS DMs IG — no es solo Lucas global.
--
-- Cambio:
-- 1. RLS de admin_push_subscriptions: permitir INSERT/SELECT/UPDATE a
--    dueno/admin/superadmin (no solo superadmin).
-- 2. La tabla sigue siendo per-user (cada user ve solo sus propias subs).
-- 3. El bot va a filtrar por tenant del config + roles relevantes para que
--    cada tenant reciba solo SUS DMs.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS admin_push_subs_insert ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_insert ON admin_push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth_usuario_id()
    AND EXISTS (
      SELECT 1 FROM usuarios
      WHERE id = auth_usuario_id()
        AND rol IN ('dueno', 'admin', 'superadmin')
        AND COALESCE(activo, true) = true
    )
  );

DROP POLICY IF EXISTS admin_push_subs_select ON admin_push_subscriptions;
CREATE POLICY admin_push_subs_select ON admin_push_subscriptions
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth_usuario_id()
    AND EXISTS (
      SELECT 1 FROM usuarios
      WHERE id = auth_usuario_id()
        AND rol IN ('dueno', 'admin', 'superadmin')
        AND COALESCE(activo, true) = true
    )
  );

-- DELETE y UPDATE se mantienen igual — el dueño de la sub puede borrarla/
-- actualizarla independiente del rol (caso típico: rotar rol del usuario
-- pero limpiar su sub vieja).

NOTIFY pgrst, 'reload schema';
