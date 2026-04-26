-- ═══════════════════════════════════════════════════════════════════════════
-- RLS granular por permiso de módulo (usuario_permisos).
-- Reemplaza las policies admin-only en tablas de master data por gates que
-- habilitan a cualquier usuario con el slug correspondiente en
-- usuario_permisos. El dueño/admin sigue pasando via CASE WHEN en el helper.
--
-- Mapeo validado:
--   proveedores        → 'proveedores' (ALL)
--   insumos            → 'insumos' (ALL)
--   recetas            → 'recetas' (ALL)
--   receta_items       → 'recetas' (ALL)  -- hija de recetas
--   config_categorias  → 'configuracion' (ALL)
--   rrhh_valores_doble → 'rrhh' (ALL)
--   usuarios           → 'usuarios' SELECT, admin-only escritura
--   usuario_permisos   → 'usuarios' SELECT, admin-only escritura
--   usuario_locales    → 'usuarios' SELECT, admin-only escritura
--   locales, mp_credenciales, auditoria → admin-only (sin tocar)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Helper SECURITY DEFINER para leer usuario_permisos sin recursión de RLS.
-- El dueño/admin pasa siempre via CASE WHEN. Los demás deben tener el slug
-- explícito en su fila de usuario_permisos.
CREATE OR REPLACE FUNCTION auth_tiene_permiso(p_slug text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth_es_dueno_o_admin() THEN true
    WHEN auth_usuario_id() IS NULL THEN false
    ELSE EXISTS (
      SELECT 1 FROM usuario_permisos up
      WHERE up.usuario_id = auth_usuario_id()
        AND up.modulo_slug = p_slug
    )
  END;
$$;

-- 2) proveedores: ALL con 'proveedores'.
DROP POLICY IF EXISTS "prov_admin_write" ON proveedores;
CREATE POLICY "prov_write" ON proveedores FOR ALL TO authenticated
  USING (auth_tiene_permiso('proveedores'))
  WITH CHECK (auth_tiene_permiso('proveedores'));

-- 3) insumos: ALL con 'insumos'.
DROP POLICY IF EXISTS "ins_admin_write" ON insumos;
CREATE POLICY "ins_write" ON insumos FOR ALL TO authenticated
  USING (auth_tiene_permiso('insumos'))
  WITH CHECK (auth_tiene_permiso('insumos'));

-- 4) recetas + receta_items: ALL con 'recetas'.
DROP POLICY IF EXISTS "rec_admin_write" ON recetas;
CREATE POLICY "rec_write" ON recetas FOR ALL TO authenticated
  USING (auth_tiene_permiso('recetas'))
  WITH CHECK (auth_tiene_permiso('recetas'));

DROP POLICY IF EXISTS "ri_admin_write" ON receta_items;
CREATE POLICY "ri_write" ON receta_items FOR ALL TO authenticated
  USING (auth_tiene_permiso('recetas'))
  WITH CHECK (auth_tiene_permiso('recetas'));

-- 5) config_categorias: ALL con 'configuracion'.
DROP POLICY IF EXISTS "cc_admin_write" ON config_categorias;
CREATE POLICY "cc_write" ON config_categorias FOR ALL TO authenticated
  USING (auth_tiene_permiso('configuracion'))
  WITH CHECK (auth_tiene_permiso('configuracion'));

-- 6) rrhh_valores_doble: ALL con 'rrhh'.
DROP POLICY IF EXISTS "rrhh_vd_admin_write" ON rrhh_valores_doble;
CREATE POLICY "rrhh_vd_write" ON rrhh_valores_doble FOR ALL TO authenticated
  USING (auth_tiene_permiso('rrhh'))
  WITH CHECK (auth_tiene_permiso('rrhh'));

-- 7) usuarios: SELECT con 'usuarios', escritura admin-only.
-- La policy usuarios_select existente (auth_id = auth.uid() OR admin) queda.
-- Agregamos una alternativa para cuando el usuario tenga permiso 'usuarios'.
-- Nota: las policies PERMISSIVE se combinan con OR, entonces con dos SELECT
-- policies un usuario matchea cualquiera.
CREATE POLICY "usuarios_select_perm" ON usuarios FOR SELECT TO authenticated
  USING (auth_tiene_permiso('usuarios'));
-- usuarios_admin_insert/update/delete y usuarios_self_update quedan intactas.

-- 8) usuario_permisos: SELECT con 'usuarios' (o propio), escritura admin-only.
-- Mantener up_select (que ya permite ver los propios o admin). Agregar
-- permiso 'usuarios' como gate adicional de lectura.
CREATE POLICY "up_select_perm" ON usuario_permisos FOR SELECT TO authenticated
  USING (auth_tiene_permiso('usuarios'));
-- up_admin_write queda: INSERT/UPDATE/DELETE siguen siendo admin-only.

-- 9) usuario_locales: idem.
CREATE POLICY "ul_select_perm" ON usuario_locales FOR SELECT TO authenticated
  USING (auth_tiene_permiso('usuarios'));
-- ul_admin_write queda intacta.

-- 10) GRANT EXECUTE de la nueva función.
GRANT EXECUTE ON FUNCTION auth_tiene_permiso(text) TO authenticated;
