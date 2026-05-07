-- Permitir que encargados vean los datos NO-secretos de mp_credenciales
-- de los locales que tienen asignados.
--
-- Reportado 2026-05-07: la encargada Carovc (locales 1,2,3,4) abría
-- /mp y veía "⚠ No hay cuentas de MercadoPago configuradas" aunque
-- existe credencial activa para el local 1 (Villa Crespo). Causa: la
-- policy mp_credenciales_mt limita SELECT a dueño/admin, mientras que
-- saldos_caja_mt sí incluye `local_id = ANY(auth_locales_visibles())`.
--
-- Diseño:
--   1. Mantener la policy existente mp_credenciales_mt para que dueño/
--      admin sigan viendo TODO incluyendo los tokens.
--   2. Agregar policy de SELECT que también deja a encargado ver las
--      filas de SUS locales.
--   3. Revocar SELECT a nivel COLUMNA sobre access_token y
--      access_token_encrypted para todos los `authenticated`. Las RPCs
--      que usan el token (mp_sync, fn_*) corren SECURITY DEFINER y no
--      son afectadas.
--   4. GRANT SELECT explícito en las columnas no-secretas para que
--      PostgREST las exponga via la nueva policy.
--
-- Garantía: encargado puede leer los campos del frontend (saldo,
-- ultima_sync, last8) pero un SELECT crudo de access_token devuelve
-- 403 por privilegio de columna.

BEGIN;

-- 1. Nueva policy SELECT que incluye encargado por local visible.
--    No reemplaza mp_credenciales_mt (que es FOR ALL); las dos políticas
--    coexisten: cualquiera que matchee deja pasar (RLS es OR).
DROP POLICY IF EXISTS mp_credenciales_select_encargado ON mp_credenciales;
CREATE POLICY mp_credenciales_select_encargado ON mp_credenciales
  FOR SELECT
  TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
    OR (tenant_id = auth_tenant_id() AND local_id = ANY(COALESCE(auth_locales_visibles(), ARRAY[]::int[])))
  );

-- 2. Revocar el SELECT table-wide previo. Si existe a nivel tabla, el
--    REVOKE de columnas individuales NO surte efecto porque el grant
--    amplio cubre todas las columnas. Hay que revocar amplio primero
--    y después dar GRANT explícito solo a las columnas no-secretas.
REVOKE SELECT ON mp_credenciales FROM authenticated;

-- 3. GRANT explícito de SELECT SOLO en columnas no-secretas. Sin esto,
--    el SELECT cae a 0 columnas accesibles para authenticated y la
--    policy queda sin sentido. NO incluye access_token ni
--    access_token_encrypted. Las RPCs SECURITY DEFINER que necesitan
--    el token bypasean RLS y leen directamente, no afectadas.
GRANT SELECT (
  id, local_id, tenant_id, activo, ultima_sync,
  access_token_last8,
  saldo_disponible, saldo_pendiente, saldo_no_disponible, saldo_total,
  saldo_inicial, saldo_inicial_at, balance_at, por_acreditar
) ON mp_credenciales TO authenticated;

COMMIT;

-- Smoke test post-aplicación (manual):
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims TO '{"sub":"<auth_id-de-carovc>"}';
--   SELECT id, local_id, saldo_disponible FROM mp_credenciales WHERE local_id = 1;
--   -- Debe devolver 1 fila.
--   SELECT access_token FROM mp_credenciales WHERE local_id = 1;
--   -- Debe devolver: ERROR: permission denied for column access_token
