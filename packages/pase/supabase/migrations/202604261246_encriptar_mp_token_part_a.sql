-- ═══════════════════════════════════════════════════════════════════════════
-- Encriptación at-rest de mp_credenciales.access_token — PARTE A.
--
-- ⚠️  ANTES DE APLICAR: reemplazar `REEMPLAZAR_CON_PASSPHRASE_DE_LUCAS`
--    por el valor guardado en password manager (PASE - mp_token_key).
--    El placeholder se restaura ANTES del commit. La passphrase real
--    NUNCA va al repo.
--
-- Esta parte sólo crea infra (columna nueva, vault, RPC) y backfillea.
-- La columna `access_token` plana sigue intacta — el código de
-- api/mp-sync.js, api/mp-process.js, api/mp-generate.js no se toca.
-- PARTE B (refactor de los .js) es una task separada.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Extensiones
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- 2. Columna nueva (NO se borra access_token todavía)
ALTER TABLE mp_credenciales
  ADD COLUMN IF NOT EXISTS access_token_encrypted bytea;

-- 3. Insert de la passphrase en vault.secrets via helper.
--    Lucas reemplaza el placeholder antes de aplicar.
--    Se usa vault.create_secret() porque INSERT directo a vault.secrets
--    requiere ejecución de _crypto_aead_det_noncegen (pgsodium), que
--    sólo el helper SECURITY DEFINER tiene permitido invocar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'mp_token_key') THEN
    PERFORM vault.create_secret('REEMPLAZAR_CON_PASSPHRASE_DE_LUCAS', 'mp_token_key');
  END IF;
END $$;

-- 4. Helper interno para leer la passphrase desencriptada del vault.
--    SECURITY DEFINER + search_path acotado + REVOKE PUBLIC: sólo
--    funciones que tengan permiso explícito (la RPC get_mp_token de
--    abajo) lo pueden invocar. authenticated/anon NO lo ven.
CREATE OR REPLACE FUNCTION _get_mp_passphrase() RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, vault
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'mp_token_key' LIMIT 1
$$;
REVOKE ALL ON FUNCTION _get_mp_passphrase() FROM public;
REVOKE ALL ON FUNCTION _get_mp_passphrase() FROM anon;
REVOKE ALL ON FUNCTION _get_mp_passphrase() FROM authenticated;

-- 5. RPC pública para desencriptar.
--    - service_role pasa siempre (lo usa mp-sync.js desde el backend).
--    - dueño/admin pasa via auth_es_dueno_o_admin().
--    - resto: NO_AUTORIZADO.
--
--    Nota: usamos auth.role() — el helper de Supabase que lee el role
--    del JWT — en lugar de current_user. Adentro de un SECURITY DEFINER
--    current_user es el definer (postgres), NO el rol del invocador,
--    así que `current_user = 'service_role'` nunca matchearía.
CREATE OR REPLACE FUNCTION get_mp_token(p_credencial_id int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, extensions
AS $$
DECLARE v_token text;
BEGIN
  IF auth.role() = 'service_role' OR auth_es_dueno_o_admin() THEN
    SELECT pgp_sym_decrypt(access_token_encrypted, _get_mp_passphrase())
    INTO v_token FROM mp_credenciales WHERE id = p_credencial_id;
    RETURN v_token;
  ELSE
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION get_mp_token(int) TO authenticated, service_role;

-- 6. Backfill: encriptar tokens existentes a la columna nueva.
--    Idempotente: sólo procesa filas que aún no tengan encrypted seteado.
UPDATE mp_credenciales
SET access_token_encrypted = pgp_sym_encrypt(access_token, _get_mp_passphrase())
WHERE access_token IS NOT NULL
  AND access_token_encrypted IS NULL;
