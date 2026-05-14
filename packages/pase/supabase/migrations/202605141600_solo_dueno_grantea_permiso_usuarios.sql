-- ═══════════════════════════════════════════════════════════════════════════
-- Hardening: solo dueño/admin/superadmin pueden grantear el permiso 'usuarios'
--
-- Fecha:    2026-05-14
-- Contexto: El fix de las RLS de usuario_permisos/usuario_locales (migration
--           202605141500) habilitó a users con permiso 'usuarios' a editar
--           permisos de otros users. Pero eso abrió un potencial privilege
--           escalation: un encargado al que se le otorga 'usuarios' podría
--           grantearse a sí mismo el permiso 'usuarios' a otros encargados,
--           o agregar permisos sensibles (Caja, Compras, etc.) a otros
--           usuarios.
--
-- Decisión:
--   - El permiso 'usuarios' otorga acceso AL MÓDULO (gestionar usuarios), pero
--     el GRANTING del permiso 'usuarios' mismo queda reservado a dueño/admin/
--     superadmin.
--   - Los demás permisos (caja, compras, ventas, ...) sí pueden ser otorgados
--     por cualquier user con permiso 'usuarios'.
--
-- Implementación: BEFORE INSERT/UPDATE trigger sobre usuario_permisos que
-- rechaza filas con modulo_slug='usuarios' cuando el caller no es dueño/
-- admin/superadmin.
--
-- Defense-in-depth: el frontend también deshabilita el checkbox 'usuarios'
-- para no-dueños/admin (ver Usuarios.tsx), pero el trigger es la fuente de
-- verdad — un cliente malicioso que skip el frontend igual choca con esto.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _check_grant_permiso_usuarios()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo nos importa el modulo 'usuarios'. Los demás permisos pasan
  -- libres (RLS WITH CHECK ya filtró que el caller tenga el permiso
  -- 'usuarios' o sea dueño/admin/superadmin).
  IF NEW.modulo_slug = 'usuarios' THEN
    -- Solo dueño/admin/superadmin pueden grantear el permiso 'usuarios'.
    -- auth_es_superadmin() y auth_es_dueno_o_admin() son SECURITY DEFINER
    -- helpers ya definidos.
    IF NOT (auth_es_superadmin() OR auth_es_dueno_o_admin()) THEN
      RAISE EXCEPTION 'NO_PUEDE_GRANTEAR_PERMISO_USUARIOS';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_grant_permiso_usuarios ON usuario_permisos;
CREATE TRIGGER check_grant_permiso_usuarios
  BEFORE INSERT OR UPDATE ON usuario_permisos
  FOR EACH ROW
  EXECUTE FUNCTION _check_grant_permiso_usuarios();
