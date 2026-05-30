-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta Fase 2 — RPC set_ig_token compatible con multi-cuenta.
-- ─────────────────────────────────────────────────────────────────────────
--
-- La fase 1 cambió ig_config PK de (tenant_id) a (id). La RPC
-- set_ig_token usaba ON CONFLICT (tenant_id) que ya no aplica → fallaba
-- el siguiente OAuth callback.
--
-- Ahora usa ON CONFLICT (tenant_id, ig_account_id) (= UNIQUE de fase 1).
-- Semántica: si ya existe esa cuenta en ese tenant, UPDATE el token
-- (re-conexión). Si es cuenta nueva (mismo tenant, distinto account_id),
-- INSERT nueva fila → multi-cuenta soportado.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_ig_token(
  p_tenant_id uuid,
  p_token text,
  p_ig_account_id text DEFAULT NULL::text,
  p_ig_username text DEFAULT NULL::text,
  p_token_creado_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_token_expira_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_local_id integer DEFAULT NULL  -- multi-cuenta: NULL = global del tenant
)
RETURNS bigint  -- retorna el id de la fila (insert o update)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_encrypted bytea;
  v_id bigint;
BEGIN
  IF auth.role() != 'service_role' AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  IF p_token IS NULL OR length(p_token) < 10 THEN
    RAISE EXCEPTION 'TOKEN_INVALIDO';
  END IF;

  IF p_ig_account_id IS NULL OR length(p_ig_account_id) < 1 THEN
    RAISE EXCEPTION 'IG_ACCOUNT_ID_REQUERIDO_PARA_MULTI_CUENTA';
  END IF;

  v_encrypted := pgp_sym_encrypt(p_token, _get_ig_passphrase());

  INSERT INTO ig_config (
    tenant_id, page_access_token_encrypted,
    ig_account_id, ig_username, token_creado_at, token_expira_at,
    local_id, updated_at
  )
  VALUES (
    p_tenant_id, v_encrypted,
    p_ig_account_id, p_ig_username, p_token_creado_at, p_token_expira_at,
    p_local_id, now()
  )
  ON CONFLICT (tenant_id, ig_account_id) DO UPDATE
    SET page_access_token_encrypted = EXCLUDED.page_access_token_encrypted,
        ig_username = COALESCE(EXCLUDED.ig_username, ig_config.ig_username),
        token_creado_at = COALESCE(EXCLUDED.token_creado_at, ig_config.token_creado_at),
        token_expira_at = COALESCE(EXCLUDED.token_expira_at, ig_config.token_expira_at),
        local_id = COALESCE(EXCLUDED.local_id, ig_config.local_id),
        desconectado_at = NULL,
        updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.set_ig_token IS
  'Guarda/actualiza token IG encriptado en ig_config. Multi-cuenta (29-may): '
  'usa UNIQUE(tenant_id, ig_account_id) en lugar de PK(tenant_id) — permite '
  'tener N cuentas IG por tenant. Retorna el id de la fila para que el caller '
  'lo asocie a un local via UPDATE posterior si hace falta.';
