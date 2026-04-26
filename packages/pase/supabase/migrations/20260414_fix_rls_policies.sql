-- Fix RLS policies: agregar TO authenticated explícito
-- Las policies originales no especificaban rol, lo que puede causar
-- que PostgREST/Supabase no las aplique correctamente.

DROP POLICY IF EXISTS "usuarios autenticados" ON usuario_permisos;
DROP POLICY IF EXISTS "usuarios autenticados" ON usuario_locales;
DROP POLICY IF EXISTS "usuarios autenticados" ON rrhh_empleados;
DROP POLICY IF EXISTS "usuarios autenticados" ON rrhh_novedades;
DROP POLICY IF EXISTS "usuarios autenticados" ON rrhh_liquidaciones;
DROP POLICY IF EXISTS "usuarios autenticados" ON rrhh_valores_doble;

CREATE POLICY "auth_full_access" ON usuario_permisos FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full_access" ON usuario_locales FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full_access" ON rrhh_empleados FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full_access" ON rrhh_novedades FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full_access" ON rrhh_liquidaciones FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full_access" ON rrhh_valores_doble FOR ALL TO authenticated USING (true) WITH CHECK (true);
