-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: ambigüedad de columna `id` en fn_crear_delivery_rider
--
-- Bug reportado (ticket eec70a1d): al crear una moto desde
-- /hardware/riders, la RPC tira "column reference 'id' is ambiguous".
--
-- Causa: el RETURNS TABLE (id BIGINT, rider_token TEXT) introduce `id`
-- como out-parameter en el scope plpgsql. Cuando dentro hago
-- "SELECT 1 FROM locales WHERE id = p_local_id", Postgres no sabe si
-- ese `id` es la columna de locales o el OUT param.
--
-- Fix: renombrar el OUT param a `rider_id`. El consumer (ridersService.ts)
-- mapea rider_id → id para mantener la API igual.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS fn_crear_delivery_rider(INTEGER, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION fn_crear_delivery_rider(
  p_local_id INTEGER,
  p_nombre TEXT,
  p_telefono TEXT DEFAULT NULL,
  p_foto_url TEXT DEFAULT NULL
) RETURNS TABLE (rider_id BIGINT, rider_token TEXT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_token TEXT;
  v_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM locales l
     WHERE l.id = p_local_id AND l.tenant_id = v_tenant_id AND l.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF p_nombre IS NULL OR length(trim(p_nombre)) = 0 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO delivery_riders (tenant_id, local_id, rider_token, nombre, telefono, foto_url)
  VALUES (
    v_tenant_id, p_local_id, v_token,
    trim(p_nombre),
    NULLIF(trim(p_telefono), ''),
    NULLIF(trim(p_foto_url), '')
  )
  RETURNING delivery_riders.id INTO v_id;

  RETURN QUERY SELECT v_id AS rider_id, v_token AS rider_token;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_crear_delivery_rider(INTEGER, TEXT, TEXT, TEXT) TO authenticated;

-- ─── Mismo fix preventivo en fn_crear_print_agent_token ──────────────────
-- Tiene mismo pattern RETURNS TABLE (id, ...). No reportado todavía
-- pero seguro va a explotar igual cuando alguien lo use.

DROP FUNCTION IF EXISTS fn_crear_print_agent_token(INTEGER, TEXT);

CREATE OR REPLACE FUNCTION fn_crear_print_agent_token(
  p_local_id INTEGER,
  p_nombre TEXT DEFAULT 'PC sin nombre'
) RETURNS TABLE (agent_id BIGINT, agent_token TEXT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_token TEXT;
  v_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM locales l
     WHERE l.id = p_local_id AND l.tenant_id = v_tenant_id AND l.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO comanda_print_agents (tenant_id, local_id, agent_token, nombre)
  VALUES (v_tenant_id, p_local_id, v_token, COALESCE(NULLIF(trim(p_nombre), ''), 'PC sin nombre'))
  RETURNING comanda_print_agents.id INTO v_id;

  RETURN QUERY SELECT v_id AS agent_id, v_token AS agent_token;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_crear_print_agent_token(INTEGER, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
