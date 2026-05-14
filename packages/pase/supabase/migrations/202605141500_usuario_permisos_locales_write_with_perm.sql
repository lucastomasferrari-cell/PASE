-- ═══════════════════════════════════════════════════════════════════════════
-- BUGFIX: usuario_permisos / usuario_locales WITH CHECK alineado con USING
--
-- Fecha:    2026-05-14
-- Reportado por: Lucas (en prod, 2026-05-14).
-- Síntoma: un user no-dueño con permiso "usuarios" entra al módulo Usuarios,
--          edita los permisos de otro user (agrega/quita uno), y al guardar
--          TODOS los permisos del editado quedan en blanco.
--
-- Causa raíz: las policies `usuario_permisos_mt` y `usuario_locales_mt`
--             (creadas en 202604281204) tienen:
--   USING       → permite leer/borrar si auth_tiene_permiso('usuarios')
--   WITH CHECK  → SOLO dueño/admin/superadmin pueden INSERT/UPDATE
--
-- Flow del bug:
--   1. User no-dueño con permiso 'usuarios' abre el módulo.
--   2. Edita user X. Frontend hace: DELETE FROM usuario_permisos WHERE usuario_id=X.
--      (Pasa por USING — permite delete.)
--   3. Frontend hace: INSERT INTO usuario_permisos (...).
--      Falla por WITH CHECK. El error se loggea pero NO se propaga al usuario.
--   4. Resultado: user X queda con 0 permisos.
--
-- Fix: hacer WITH CHECK simétrico con USING — quien puede leer/borrar también
-- puede insertar/actualizar. Es el contrato esperado del permiso 'usuarios'.
--
-- Nota de seguridad: cualquier user con permiso 'usuarios' puede dar/quitar
-- permisos a OTROS, incluido el permiso 'usuarios' mismo (potencial privilege
-- escalation). Lucas evalúa si necesita bloquear ese self-grant en una
-- iteración posterior — por ahora el permiso 'usuarios' implica confianza
-- total para gestionar el módulo.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "usuario_permisos_mt" ON usuario_permisos;
CREATE POLICY "usuario_permisos_mt" ON usuario_permisos FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR usuario_id = auth_usuario_id()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  );

DROP POLICY IF EXISTS "usuario_locales_mt" ON usuario_locales;
CREATE POLICY "usuario_locales_mt" ON usuario_locales FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR usuario_id = auth_usuario_id()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  );
