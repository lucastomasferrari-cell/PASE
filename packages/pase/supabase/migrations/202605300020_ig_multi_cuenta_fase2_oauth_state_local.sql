-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta Fase 2 — RPC fn_ig_oauth_iniciar acepta p_local_id
-- ─────────────────────────────────────────────────────────────────────────
--
-- Permite que el frontend pase qué local va a tener esa cuenta IG cuando
-- inicia el OAuth flow. El state lo lleva consigo hasta que callback lo
-- consume + crea la fila ig_config con ese local_id.
--
-- Backward compat: si no se pasa, queda NULL = cuenta global del tenant.
-- ─────────────────────────────────────────────────────────────────────────

-- La columna local_id en ig_oauth_states ya se agregó vía ALTER en caliente.

DROP FUNCTION IF EXISTS fn_ig_oauth_iniciar(TEXT);

CREATE OR REPLACE FUNCTION fn_ig_oauth_iniciar(
  p_return_url TEXT DEFAULT NULL,
  p_local_id INTEGER DEFAULT NULL  -- multi-cuenta: NULL = global del tenant
) RETURNS TABLE (
  state TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_state TEXT;
  v_expires_at TIMESTAMPTZ;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'SOLO_DUENO_O_ADMIN';
  END IF;

  -- Validar que el local pertenezca al tenant del caller (defensa cross-tenant).
  IF p_local_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM locales WHERE id = p_local_id AND tenant_id = v_tenant_id
    ) THEN
      RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
    END IF;
  END IF;

  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  v_state := REPLACE(gen_random_uuid()::TEXT, '-', '')
          || REPLACE(gen_random_uuid()::TEXT, '-', '');
  v_expires_at := NOW() + INTERVAL '15 minutes';

  INSERT INTO ig_oauth_states (state, tenant_id, usuario_id, return_url, expires_at, local_id)
  VALUES (v_state, v_tenant_id, v_user_id, p_return_url, v_expires_at, p_local_id);

  RETURN QUERY SELECT v_state, v_expires_at;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_ig_oauth_iniciar(TEXT, INTEGER) TO authenticated;

COMMENT ON FUNCTION fn_ig_oauth_iniciar IS
  'Inicia OAuth flow IG. Multi-cuenta (29-may): p_local_id opcional para '
  'asociar la cuenta IG a un local específico. NULL = global del tenant.';
