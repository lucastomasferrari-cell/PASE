-- =============================================================================
-- AUDIT F6 — Bot IG: CHECK constraints + drop columna page_access_token plain
-- =============================================================================
-- F6A#4: `max_tokens`, `system_prompt`, `contexto_mensajes` no tenían CHECK
-- server-side. RLS permite UPDATE para dueno/admin del tenant. Un user con
-- esos roles podía setear `max_tokens=200000` → ~$3 USD por mensaje en
-- Sonnet, sin tope. La UI tenía slider 256-2048 pero no enforced server.
--
-- F2D #27 fase 2: drop columna `page_access_token` plana ahora que está
-- encrypted vivo y los 4 endpoints IG ya usan get_ig_token RPC (commit F2).
-- La columna plain queda como fallback temporal hasta este drop.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- F6A#4: CHECK constraints en ig_config
-- -----------------------------------------------------------------------------

-- max_tokens razonable: 256 mínimo (respuesta útil), 4096 máximo (suficiente
-- para conversaciones largas). UI slider está en 256-2048; permitimos hasta
-- 4096 para flexibilidad pero protege contra el bug del 200000.
ALTER TABLE ig_config
  ADD CONSTRAINT ig_config_max_tokens_range
  CHECK (max_tokens IS NULL OR (max_tokens >= 256 AND max_tokens <= 4096));

-- contexto_mensajes: cuántos mensajes históricos pasamos a Claude.
-- Mínimo 1, máximo 50 (más es ruido + costo).
ALTER TABLE ig_config
  ADD CONSTRAINT ig_config_contexto_range
  CHECK (contexto_mensajes IS NULL OR (contexto_mensajes >= 1 AND contexto_mensajes <= 50));

-- system_prompt: 8000 chars máximo (~2000 tokens — más es waste).
ALTER TABLE ig_config
  ADD CONSTRAINT ig_config_system_prompt_size
  CHECK (system_prompt IS NULL OR length(system_prompt) <= 8000);

-- rate_limit_msgs: 0 = disabled, hasta 500.
ALTER TABLE ig_config
  ADD CONSTRAINT ig_config_rate_limit_msgs_range
  CHECK (rate_limit_msgs IS NULL OR (rate_limit_msgs >= 0 AND rate_limit_msgs <= 500));

-- rate_limit_minutos: 1 a 1440 (1 día).
ALTER TABLE ig_config
  ADD CONSTRAINT ig_config_rate_limit_minutos_range
  CHECK (rate_limit_minutos IS NULL OR (rate_limit_minutos >= 1 AND rate_limit_minutos <= 1440));

-- -----------------------------------------------------------------------------
-- F2D #27 fase 2: drop columna page_access_token plana.
-- Los 4 endpoints IG (webhook, send, oauth-callback, refresh-tokens) usan
-- get_ig_token RPC desde el commit F2. La columna encrypted está backfilled.
-- Es seguro dropear ahora.
-- -----------------------------------------------------------------------------

-- Primero: actualizar get_ig_token para NO usar el fallback a la columna plain
-- (ya no existirá). Si por algún motivo la fila no tiene encrypted, RAISE.
CREATE OR REPLACE FUNCTION get_ig_token(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_token text;
  v_encrypted bytea;
BEGIN
  IF auth.role() != 'service_role'
     AND NOT auth_es_superadmin()
     AND (NOT auth_es_dueno_o_admin() OR p_tenant_id IS DISTINCT FROM auth_tenant_id()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT page_access_token_encrypted INTO v_encrypted
    FROM ig_config WHERE tenant_id = p_tenant_id;

  IF v_encrypted IS NULL THEN
    RAISE EXCEPTION 'IG_TOKEN_NOT_FOUND para tenant %', p_tenant_id;
  END IF;

  v_token := pgp_sym_decrypt(v_encrypted, _get_ig_passphrase());
  RETURN v_token;
END;
$$;
GRANT EXECUTE ON FUNCTION get_ig_token(uuid) TO authenticated, service_role;

-- set_ig_token ya no necesita escribir page_access_token plain.
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
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  IF p_token IS NULL OR length(p_token) < 10 THEN
    RAISE EXCEPTION 'TOKEN_INVALIDO';
  END IF;

  v_encrypted := pgp_sym_encrypt(p_token, _get_ig_passphrase());

  INSERT INTO ig_config (
    tenant_id, page_access_token_encrypted,
    ig_account_id, ig_username, token_creado_at, token_expira_at,
    updated_at
  )
  VALUES (
    p_tenant_id, v_encrypted,
    p_ig_account_id, p_ig_username, p_token_creado_at, p_token_expira_at,
    now()
  )
  ON CONFLICT (tenant_id) DO UPDATE
    SET page_access_token_encrypted = EXCLUDED.page_access_token_encrypted,
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

-- Ahora sí: drop la columna plana.
ALTER TABLE ig_config DROP COLUMN page_access_token;

-- =============================================================================
-- SMOKE CHECKS
-- =============================================================================
DO $$
DECLARE v_n integer;
BEGIN
  -- 5 CHECK constraints nuevos
  SELECT COUNT(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'ig_config'::regclass
     AND conname IN ('ig_config_max_tokens_range','ig_config_contexto_range',
                     'ig_config_system_prompt_size','ig_config_rate_limit_msgs_range',
                     'ig_config_rate_limit_minutos_range');
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'SMOKE FAIL F6A#4: esperaba 5 CHECK constraints, encontré %', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK F6A#4: 5 CHECK constraints aplicados';

  -- page_access_token plana borrada
  SELECT COUNT(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='ig_config' AND column_name='page_access_token';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL F2D#27 fase 2: page_access_token plana sigue presente';
  END IF;
  RAISE NOTICE 'SMOKE OK F2D#27 fase 2: columna page_access_token plana borrada';

  -- Confirmar que todas las filas IG tienen encrypted
  SELECT COUNT(*) INTO v_n FROM ig_config WHERE page_access_token_encrypted IS NULL;
  IF v_n > 0 THEN
    RAISE WARNING '⚠ % rows IG sin token encrypted — verificar', v_n;
  END IF;
END $$;

COMMIT;
