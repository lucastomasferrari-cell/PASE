-- ============================================================
-- 202607170200_rol_pos_local_para_users_del_local.sql
-- Nuevo rol_pos 'pos_local' para usuarios que son "acceso POS del local"
-- (no personas de nómina, no admins de la app). Reemplaza el uso incorrecto
-- de rol_pos='admin' para estos usuarios.
--
-- Contexto (Lucas 17-jul): nekodevoto se creó como acceso POS del local
-- Devoto. Se le puso rol_pos='admin' para bypass de operaciones POS, pero
-- eso también le da acceso al panel Admin — problema estructural.
--
-- Con este rol:
--   - Puede operar el POS (todas las operaciones diarias: cobrar, mesas,
--     caja, etc.)
--   - NO puede entrar al panel Admin (no tiene ADMIN_ONLY_SLUGS)
--   - El acceso Admin queda blindado a users reales con permisos explícitos
--     (dueño, encargados con roles/permisos asignados desde Accesos).
--
-- Steps:
--   1) Ampliar el CHECK de comanda_usuarios.rol_pos con 'pos_local'.
--   2) Sembrar rol_pos_permisos para 'pos_local' con TODOS los slugs POS
--      (los que necesita para operar sin bloqueos).
--   3) Bajar nekodevoto de 'admin' → 'pos_local'.
-- ============================================================

BEGIN;

-- 1a) Ampliar el CHECK de comanda_usuarios.rol_pos (users que se loguean con
--     email/password). Agrega 'pos_local'.
ALTER TABLE comanda_usuarios DROP CONSTRAINT comanda_usuarios_rol_pos_check;
ALTER TABLE comanda_usuarios ADD CONSTRAINT comanda_usuarios_rol_pos_check
  CHECK (rol_pos = ANY (ARRAY['mozo'::text, 'cajero'::text, 'manager'::text, 'admin'::text, 'pos_local'::text]));

-- 1b) Ampliar el CHECK de rol_pos_permisos.rol_pos también — esta tabla
--     se comparte con rrhh_empleados (que tienen valores distintos:
--     cajero/encargado/manager/dueno/bartender). Agregamos 'pos_local'
--     para poder sembrar sus permisos.
ALTER TABLE rol_pos_permisos DROP CONSTRAINT rol_pos_permisos_rol_pos_check;
ALTER TABLE rol_pos_permisos ADD CONSTRAINT rol_pos_permisos_rol_pos_check
  CHECK (rol_pos = ANY (ARRAY['cajero'::text, 'encargado'::text, 'manager'::text, 'dueno'::text, 'bartender'::text, 'pos_local'::text]));

-- 2) Sembrar rol_pos_permisos para 'pos_local'. Incluye todas las operaciones
--    POS que un cajero/manager pudiera hacer desde este login (el permiso
--    real por operación queda ejercido por el empleado con PIN activo:
--    rrhh_empleados.rol_pos define quién puede qué desde el PinPad).
--    Estos slugs son para que comanda_auth_tiene_permiso no bloquee las RPCs
--    invocadas por la sesión de nekodevoto.
INSERT INTO rol_pos_permisos (rol_pos, slug, activo) VALUES
  ('pos_local', 'comanda.ventas.cobrar',        true),
  ('pos_local', 'comanda.ventas.anular',        true),
  ('pos_local', 'comanda.ventas.descuento',     true),
  ('pos_local', 'comanda.ventas.refund',        true),
  ('pos_local', 'comanda.ventas.reopen',        true),
  ('pos_local', 'comanda.mesas.gestionar',      true),
  ('pos_local', 'comanda.caja.abrir',           true),
  ('pos_local', 'comanda.caja.cerrar',          true),
  ('pos_local', 'comanda.caja.movimientos',     true),
  ('pos_local', 'comanda.caja.ver_esperado_cierre', true),
  ('pos_local', 'comanda.catalogo.ver',         true),
  ('pos_local', 'comanda.tienda.aprobar',       true),
  ('pos_local', 'comanda.reportes.ver',         true),
  ('pos_local', 'comanda.pagos.ver',            true),
  ('pos_local', 'comanda.clientes.ver',         true),
  ('pos_local', 'comanda.empleados.ver',        true),
  ('pos_local', 'comanda.salon.editar',         true)
ON CONFLICT DO NOTHING;

-- 3) Bajar nekodevoto de 'admin' → 'pos_local'.
--    Nota: el trigger prevent_delete_last_admin_tenant chequea que el tenant
--    quede con >= 1 admin activo. Como 'dueno' sigue siendo admin, este
--    UPDATE pasa. Verificado antes de correr esta migración.
UPDATE comanda_usuarios
   SET rol_pos = 'pos_local'
 WHERE email = 'nekodevoto' AND rol_pos = 'admin';

-- 4) Ampliar comanda_auth_tiene_permiso para que ADEMÁS consulte
--    rol_pos_permisos. Antes solo miraba comanda_usuario_permisos (permisos
--    individuales del user); ahora también mira los slugs asignados a su
--    rol vía rol_pos_permisos. Esto es lo que hace efectivos los slugs que
--    sembramos arriba para 'pos_local'. Los users con rol_pos='admin' siguen
--    con bypass total (unchanged).
CREATE OR REPLACE FUNCTION comanda_auth_tiene_permiso(p_slug text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $function$
DECLARE
  v_auth uuid := auth.uid();
  v_usuario_id uuid;
  v_rol_pos text;
  v_existe boolean;
BEGIN
  IF v_auth IS NULL THEN RETURN false; END IF;

  SELECT id, rol_pos INTO v_usuario_id, v_rol_pos
  FROM comanda_usuarios
  WHERE auth_id = v_auth AND activo = true
  LIMIT 1;

  IF v_usuario_id IS NULL THEN RETURN false; END IF;

  -- Admin POS = bypass total (unchanged).
  IF v_rol_pos = 'admin' THEN RETURN true; END IF;

  -- Slug asignado individualmente al user (unchanged).
  SELECT EXISTS(
    SELECT 1 FROM comanda_usuario_permisos
    WHERE comanda_usuario_id = v_usuario_id AND modulo_slug = p_slug
  ) INTO v_existe;
  IF v_existe THEN RETURN true; END IF;

  -- NUEVO: slug asignado al rol_pos del user vía rol_pos_permisos.
  -- Permite que rol_pos='pos_local' herede sus permisos sin tener que
  -- copiarlos user-por-user.
  SELECT EXISTS(
    SELECT 1 FROM rol_pos_permisos
    WHERE rol_pos = v_rol_pos AND slug = p_slug AND activo = true
  ) INTO v_existe;
  RETURN COALESCE(v_existe, false);
END; $function$;

COMMIT;
