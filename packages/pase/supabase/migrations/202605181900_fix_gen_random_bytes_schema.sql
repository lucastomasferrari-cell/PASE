-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: gen_random_bytes vive en schema `extensions` en Supabase
-- Sesión 2026-05-18
--
-- Bug encontrado al testear el feature TOTP (Lucas, 2026-05-18):
--   ERROR: function gen_random_bytes(integer) does not exist
--
-- Causa: las RPCs creadas en 202605180000 tienen `SET search_path = public`
-- (regla de seguridad para evitar search_path hijacking). Pero en Supabase
-- la extensión pgcrypto se instala en el schema `extensions`, no en
-- `public`. Por eso `gen_random_bytes(20)` sin calificar falla.
--
-- Fix: cualificar la llamada como `extensions.gen_random_bytes(...)` en
-- las 2 RPCs que la usan (generar_tenant_totp_secret + obtener_codigo_
-- totp_actual). Idempotente — CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION generar_tenant_totp_secret()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id INTEGER := auth_usuario_id();
  v_tenant UUID := auth_tenant_id();
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AUTH_SIN_TENANT';
  END IF;
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede generar secret TOTP';
  END IF;

  INSERT INTO tenant_totp_secret (tenant_id, secret, created_by)
  VALUES (v_tenant, extensions.gen_random_bytes(20), v_caller_id)
  ON CONFLICT (tenant_id) DO UPDATE
    SET secret = extensions.gen_random_bytes(20),
        updated_at = NOW(),
        created_by = v_caller_id;
END;
$$;

CREATE OR REPLACE FUNCTION obtener_codigo_totp_actual()
RETURNS TABLE(codigo TEXT, segundos_restantes INT, time_step BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := auth_tenant_id();
  v_secret BYTEA;
  v_now BIGINT := extract(epoch FROM NOW())::BIGINT;
  v_step BIGINT;
BEGIN
  IF auth_usuario_id() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AUTH_SIN_TENANT';
  END IF;
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede ver códigos TOTP';
  END IF;

  -- Lazy-init: si no existe secret, lo creamos (cualificado con schema).
  SELECT s.secret INTO v_secret FROM tenant_totp_secret s WHERE s.tenant_id = v_tenant;
  IF v_secret IS NULL THEN
    INSERT INTO tenant_totp_secret (tenant_id, secret, created_by)
    VALUES (v_tenant, extensions.gen_random_bytes(20), auth_usuario_id())
    RETURNING tenant_totp_secret.secret INTO v_secret;
  END IF;

  v_step := v_now / 30;

  RETURN QUERY SELECT
    fn_calcular_totp(v_secret, v_step),
    (30 - (v_now % 30))::INT,
    v_step;
END;
$$;

-- También cualifico hmac() en fn_calcular_totp por las dudas (también es
-- de pgcrypto). Aunque pueda funcionar en algunos contextos, mejor explicito.
CREATE OR REPLACE FUNCTION fn_calcular_totp(p_secret BYTEA, p_time_step BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_counter BYTEA;
  v_hmac BYTEA;
  v_offset INT;
  v_truncated BIGINT;
BEGIN
  v_counter := decode('0000000000000000', 'hex');
  v_counter := set_byte(v_counter, 4, ((p_time_step >> 24) & 255)::INT);
  v_counter := set_byte(v_counter, 5, ((p_time_step >> 16) & 255)::INT);
  v_counter := set_byte(v_counter, 6, ((p_time_step >> 8) & 255)::INT);
  v_counter := set_byte(v_counter, 7, (p_time_step & 255)::INT);

  v_hmac := extensions.hmac(v_counter, p_secret, 'sha1');

  v_offset := get_byte(v_hmac, 19) & 15;

  v_truncated :=
    ((get_byte(v_hmac, v_offset) & 127)::BIGINT << 24) |
    (get_byte(v_hmac, v_offset + 1)::BIGINT << 16) |
    (get_byte(v_hmac, v_offset + 2)::BIGINT << 8) |
    (get_byte(v_hmac, v_offset + 3)::BIGINT);

  RETURN LPAD((v_truncated % 1000000)::TEXT, 6, '0');
END;
$$;

NOTIFY pgrst, 'reload schema';
