-- ═══════════════════════════════════════════════════════════════════════════
-- Accesos: control de acceso por app (PASE/COMANDA/MESA/Habitué/Accesos)
-- 25-jun-2026
--
-- Lo gestiona el dueño desde Accesos (app del ecosistema). Cada app chequea
-- esta columna al login: si la app NO está en `apps_permitidas`, bloquea con
-- mensaje claro. Default 'pase' mantiene compat para todos los usuarios actuales.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS apps_permitidas TEXT[] NOT NULL DEFAULT ARRAY['pase']::TEXT[];

COMMENT ON COLUMN usuarios.apps_permitidas IS
  'Lista de apps del ecosistema a las que el usuario puede entrar. Valores: pase|comanda|mesa|habitue|accesos. Gestionado desde la app Accesos por el dueño.';

CREATE INDEX IF NOT EXISTS idx_usuarios_apps_permitidas
  ON usuarios USING GIN (apps_permitidas);

-- Auditoría de cambios de accesos (futuro: Accesos escribe acá cada vez que
-- el dueño cambia permisos/apps/locales de un usuario).
CREATE TABLE IF NOT EXISTS accesos_audit (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  actor_id     INTEGER     NOT NULL,        -- usuarios.id del dueño/admin que hizo el cambio
  usuario_id   INTEGER     NOT NULL,        -- usuarios.id afectado
  accion       TEXT        NOT NULL,        -- crear / editar / activar / desactivar / reset_password / cambio_rol / cambio_apps / cambio_locales / cambio_permisos / reset_pin
  detalle      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE accesos_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accesos_audit_by_tenant" ON accesos_audit
  FOR ALL TO authenticated
  USING  (tenant_id = auth_tenant_id()::text)
  WITH CHECK (tenant_id = auth_tenant_id()::text);

CREATE INDEX IF NOT EXISTS accesos_audit_usuario_idx
  ON accesos_audit (tenant_id, usuario_id, created_at DESC);

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'usuarios' AND column_name = 'apps_permitidas') = 1,
         'usuarios.apps_permitidas no creada';
  ASSERT (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name = 'accesos_audit') = 1,
         'accesos_audit no creada';
END;
$$;
