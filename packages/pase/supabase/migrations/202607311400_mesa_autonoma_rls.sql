-- MESA autónoma (31-jul-2026)
-- ---------------------------------------------------------------------------
-- Problema (bug Carlitos): las funciones de configuración de MESA (config de
-- reservas, perfil público, plano de mesas, combinaciones) estaban gated por
-- permisos de COMANDA (comanda.config.editar / comanda.mesas.gestionar). Pero
-- la ficha de Accesos NO expone permisos granulares de MESA — solo dice
-- "acceso completo". Un encargado de reservas con acceso a MESA pero SIN acceso
-- a COMANDA no podía guardar nada, aunque la UI prometiera "acceso completo".
--
-- Decisión (Lucas): MESA autónoma. Tener la app MESA en apps_permitidas + el
-- local visible alcanza para gestionar todo MESA, sin depender de COMANDA.
--
-- Cambio ADITIVO: se preserva intacto el camino de COMANDA (dueño/admin o el
-- permiso comanda.*) y se agrega un OR nuevo para usuarios con la app 'mesa'.

-- Helper: ¿el usuario autenticado tiene la app <p_app> en apps_permitidas?
-- SECURITY DEFINER para poder leer usuarios (que tiene su propia RLS).
CREATE OR REPLACE FUNCTION auth_tiene_app(p_app text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND activo
      AND p_app = ANY(apps_permitidas)
  );
$$;
REVOKE ALL ON FUNCTION auth_tiene_app(text) FROM public;
GRANT EXECUTE ON FUNCTION auth_tiene_app(text) TO authenticated;

-- 1) comanda_local_settings — config de reservas + perfil público de MESA
DROP POLICY IF EXISTS comanda_local_settings_write ON comanda_local_settings;
CREATE POLICY comanda_local_settings_write ON comanda_local_settings
  FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_permiso('comanda.config.editar'))
    OR (tenant_id = auth_tenant_id()
        AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_app('mesa'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_permiso('comanda.config.editar'))
    OR (tenant_id = auth_tenant_id()
        AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_app('mesa'))
  );

-- 2) mesas — plano del salón (compartida MESA + COMANDA salón)
DROP POLICY IF EXISTS mesas_write ON mesas;
CREATE POLICY mesas_write ON mesas
  FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_permiso('comanda.mesas.gestionar'))
    OR (tenant_id = auth_tenant_id()
        AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_app('mesa'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_permiso('comanda.mesas.gestionar'))
    OR (tenant_id = auth_tenant_id()
        AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_app('mesa'))
  );

-- 3) reservas_combinaciones — combinar mesas para reservas (MESA-only)
DROP POLICY IF EXISTS rc_write ON reservas_combinaciones;
CREATE POLICY rc_write ON reservas_combinaciones
  FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_permiso('comanda.mesas.gestionar'))
    OR (tenant_id = auth_tenant_id()
        AND local_id = ANY(auth_locales_visibles())
        AND auth_tiene_app('mesa'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
        AND auth_tiene_permiso('comanda.mesas.gestionar'))
    OR (tenant_id = auth_tenant_id()
        AND local_id = ANY(auth_locales_visibles())
        AND auth_tiene_app('mesa'))
  );
