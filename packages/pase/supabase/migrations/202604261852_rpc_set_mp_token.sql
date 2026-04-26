-- ═══════════════════════════════════════════════════════════════════════════
-- Encripta el write-path de mp_credenciales.
--
-- Antes: ConciliacionMP.tsx hacía upsert directo de access_token plano.
-- Ahora: llama a set_mp_token() (SECURITY DEFINER) que encripta server-side.
--
-- Durante la transición seguimos escribiendo a ambas columnas
-- (access_token plana Y access_token_encrypted) — el código de cron lee
-- encrypted vía get_mp_token(), así que la plana queda como safety net.
-- Una migration futura dropea la plana cuando todo esté estable.
--
-- Schema real de mp_credenciales (las columnas user_id/alias/account_email
-- mencionadas en el plan original NO existen — la spec se ajusta a la
-- realidad de la tabla: id, local_id, access_token, activo, ultima_sync,
-- saldos, etc).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columna access_token_last8 — UX para mostrar últimos 8 chars del token.
--    Sin tener que persistir el token plano "para mostrar".
ALTER TABLE mp_credenciales
  ADD COLUMN IF NOT EXISTS access_token_last8 text;

-- Backfill desde la columna plana existente.
UPDATE mp_credenciales
SET access_token_last8 = right(access_token, 8)
WHERE access_token_last8 IS NULL AND access_token IS NOT NULL;

-- 2. RPC set_mp_token: encripta y guarda en una sola transacción.
--    auth_es_dueno_o_admin() filtra a quién la puede invocar (sólo dueño/
--    admin agregan credenciales MP nuevas).
CREATE OR REPLACE FUNCTION public.set_mp_token(
  p_local_id integer,
  p_access_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id int;
  v_token_encrypted bytea;
  v_token_last8 text;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  IF p_local_id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_INVALIDO';
  END IF;
  IF p_access_token IS NULL OR length(p_access_token) < 10 THEN
    RAISE EXCEPTION 'TOKEN_INVALIDO';
  END IF;

  v_token_encrypted := pgp_sym_encrypt(p_access_token, _get_mp_passphrase());
  v_token_last8 := right(p_access_token, 8);

  INSERT INTO mp_credenciales (local_id, access_token, access_token_encrypted, access_token_last8, activo)
  VALUES (p_local_id, p_access_token, v_token_encrypted, v_token_last8, true)
  ON CONFLICT (local_id) DO UPDATE
    SET access_token = EXCLUDED.access_token,
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        access_token_last8 = EXCLUDED.access_token_last8,
        activo = true
  RETURNING id INTO v_id;

  PERFORM _auditar('mp_credenciales', 'UPSERT', jsonb_build_object(
    'cred_id', v_id, 'local_id', p_local_id,
    'token_last8', v_token_last8, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('id', v_id, 'token_last8', v_token_last8);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_mp_token(integer, text) TO authenticated;
