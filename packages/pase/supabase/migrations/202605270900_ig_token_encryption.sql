-- =============================================================================
-- AUDIT F2D #27 — IG page_access_token encryption at-rest
-- =============================================================================
-- Antes: ig_config.page_access_token en TEXT plano (a pesar del comentario
-- que decía "encriptado a nivel aplicación"). Dump de Postgres exponía
-- tokens IG long-lived (60d) de todos los tenants.
--
-- Después: patrón espejo de mp_credenciales.access_token_encrypted:
--   1. columna bytea encrypted con pgp_sym_encrypt
--   2. vault.secrets contiene la passphrase (256 bits random)
--   3. RPC get_ig_token(tenant_id) SECURITY DEFINER para leer
--   4. RPC set_ig_token(tenant_id, token) SECURITY DEFINER para escribir
--   5. backfill encripta tokens existentes
--   6. la columna TEXT plano se mantiene en este commit para no romper
--      endpoints durante el deploy. Drop en una migration posterior una
--      vez que los endpoints estén leyendo de la columna encrypted.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- 1. Columna nueva
ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS page_access_token_encrypted bytea;

-- 2. Vault secret con passphrase aleatoria 256-bit.
-- A diferencia de mp_token_key (que era passphrase humana de Lucas), acá
-- generamos cripto-random para que NADIE la conozca: solo la DB la usa
-- via _get_ig_passphrase(). El dump del DB-sin-vault no descifra los
-- tokens encrypted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'ig_token_key') THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'base64'),
      'ig_token_key'
    );
  END IF;
END $$;

-- 3. Helper interno para leer la passphrase desencriptada
CREATE OR REPLACE FUNCTION _get_ig_passphrase() RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, vault
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'ig_token_key' LIMIT 1
$$;
REVOKE ALL ON FUNCTION _get_ig_passphrase() FROM public;
REVOKE ALL ON FUNCTION _get_ig_passphrase() FROM anon;
REVOKE ALL ON FUNCTION _get_ig_passphrase() FROM authenticated;

-- 4. RPC pública para LEER token desencriptado.
-- Solo service_role (backend bot) y dueño/admin del propio tenant pueden leer.
-- Fallback al texto plano (durante migración) si el encrypted está NULL.
CREATE OR REPLACE FUNCTION get_ig_token(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_token text;
  v_encrypted bytea;
  v_plain text;
BEGIN
  IF auth.role() != 'service_role'
     AND NOT auth_es_superadmin()
     AND (NOT auth_es_dueno_o_admin() OR p_tenant_id IS DISTINCT FROM auth_tenant_id()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT page_access_token_encrypted, page_access_token
    INTO v_encrypted, v_plain
    FROM ig_config
   WHERE tenant_id = p_tenant_id;

  IF v_encrypted IS NOT NULL THEN
    v_token := pgp_sym_decrypt(v_encrypted, _get_ig_passphrase());
  ELSE
    -- Fallback temporal a la columna plana (durante deploy).
    v_token := v_plain;
  END IF;

  RETURN v_token;
END;
$$;
GRANT EXECUTE ON FUNCTION get_ig_token(uuid) TO authenticated, service_role;

-- 5. RPC pública para ESCRIBIR token (encripta + sincroniza columna plana
-- por compat). Usada por oauth-callback (upsert) y refresh-tokens (update).
CREATE OR REPLACE FUNCTION set_ig_token(
  p_tenant_id uuid,
  p_token text,
  p_ig_account_id text DEFAULT NULL,
  p_ig_username text DEFAULT NULL,
  p_token_creado_at timestamptz DEFAULT NULL,
  p_token_expira_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE v_encrypted bytea;
BEGIN
  IF auth.role() != 'service_role' AND NOT auth_es_superadmin() THEN
    -- Setear/rotar tokens IG es operación de backend (oauth-callback,
    -- refresh-tokens cron). Los users no deben llamarla directo.
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  IF p_token IS NULL OR length(p_token) < 10 THEN
    RAISE EXCEPTION 'TOKEN_INVALIDO';
  END IF;

  v_encrypted := pgp_sym_encrypt(p_token, _get_ig_passphrase());

  INSERT INTO ig_config (
    tenant_id, page_access_token, page_access_token_encrypted,
    ig_account_id, ig_username, token_creado_at, token_expira_at,
    updated_at
  )
  VALUES (
    p_tenant_id, p_token, v_encrypted,
    p_ig_account_id, p_ig_username, p_token_creado_at, p_token_expira_at,
    now()
  )
  ON CONFLICT (tenant_id) DO UPDATE
    SET page_access_token = EXCLUDED.page_access_token,
        page_access_token_encrypted = EXCLUDED.page_access_token_encrypted,
        ig_account_id = COALESCE(EXCLUDED.ig_account_id, ig_config.ig_account_id),
        ig_username = COALESCE(EXCLUDED.ig_username, ig_config.ig_username),
        token_creado_at = COALESCE(EXCLUDED.token_creado_at, ig_config.token_creado_at),
        token_expira_at = COALESCE(EXCLUDED.token_expira_at, ig_config.token_expira_at),
        desconectado_at = NULL,
        updated_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION set_ig_token(uuid, text, text, text, timestamptz, timestamptz) TO service_role;
REVOKE EXECUTE ON FUNCTION set_ig_token(uuid, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- 6. Backfill: encriptar tokens existentes en la columna nueva.
UPDATE ig_config
   SET page_access_token_encrypted = pgp_sym_encrypt(page_access_token, _get_ig_passphrase())
 WHERE page_access_token IS NOT NULL
   AND page_access_token_encrypted IS NULL;

-- Smoke check
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT COUNT(*) INTO v_n FROM ig_config WHERE page_access_token IS NOT NULL AND page_access_token_encrypted IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % rows IG sin encriptar post-backfill', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK: todos los tokens IG están encrypted (backfill OK)';
END $$;

COMMIT;
