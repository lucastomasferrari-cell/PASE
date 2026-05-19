-- ═══════════════════════════════════════════════════════════════════════════
-- Print Agents — heartbeat del COMANDA Print Server
--
-- Cada local tiene 1 (o más) PCs corriendo el "COMANDA Print Agent" que
-- imprime las comandas a las impresoras térmicas. Cada agente envía
-- heartbeat cada 60s con stats de impresoras + cola. Sirve para:
--   1. Que Lucas/dueño desde su casa vea si algún local tiene la
--      impresora caída (last_seen_at > 3min = ALERTA).
--   2. Diagnóstico cuando un cliente se queja "no me llegó la comanda".
--   3. Auditoría: cuántos jobs imprimió cada PC en el día.
--
-- Vinculación: el dueño/admin entra al POS → Hardware → Agentes → genera
-- un token único, lo copia al instalador en el primer arranque, y el
-- agent queda asociado al local.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS comanda_print_agents (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  local_id        INTEGER NOT NULL,
  -- Token único — el agent lo manda en cada heartbeat. SECURE: rotable.
  agent_token     TEXT UNIQUE NOT NULL,
  -- Identificación humana ("PC Cocina", "PC Caja"). Editable.
  nombre          TEXT NOT NULL DEFAULT 'PC sin nombre',
  -- Auto-reportado por el agent
  hostname        TEXT,
  os_platform     TEXT, -- 'win32' | 'darwin' | 'linux'
  agent_version   TEXT,
  -- Métricas más recientes (de hash. el heartbeat las pisa)
  last_seen_at    TIMESTAMPTZ,
  printers_total  INTEGER DEFAULT 0,
  printers_online INTEGER DEFAULT 0,
  queue_queued    INTEGER DEFAULT 0,
  queue_printing  INTEGER DEFAULT 0,
  queue_failed    INTEGER DEFAULT 0,
  queue_dead_letter INTEGER DEFAULT 0,
  -- Detalle (nombres impresoras, estados, etc.) para mostrar en UI
  metadata        JSONB DEFAULT '{}'::jsonb,
  -- Auditoría
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  -- FK soft (no constraints porque locales puede tener varios tenants en futuro)
  CONSTRAINT check_local_id CHECK (local_id > 0)
);

CREATE INDEX IF NOT EXISTS idx_print_agents_tenant_local
  ON comanda_print_agents(tenant_id, local_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_print_agents_token
  ON comanda_print_agents(agent_token) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_print_agents_last_seen
  ON comanda_print_agents(last_seen_at DESC) WHERE deleted_at IS NULL;

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE comanda_print_agents ENABLE ROW LEVEL SECURITY;

-- Dueño/admin del tenant + scope por local visible
CREATE POLICY print_agents_select ON comanda_print_agents
  FOR SELECT TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  );

CREATE POLICY print_agents_insert ON comanda_print_agents
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  );

CREATE POLICY print_agents_update ON comanda_print_agents
  FOR UPDATE TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  );

-- ─── Updated_at trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_print_agents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS print_agents_updated_at ON comanda_print_agents;
CREATE TRIGGER print_agents_updated_at
  BEFORE UPDATE ON comanda_print_agents
  FOR EACH ROW EXECUTE FUNCTION trg_print_agents_updated_at();

-- ─── RPC: crear agent token (vinculación) ─────────────────────────────────
--
-- Llamada desde el POS COMANDA cuando el dueño entra a Hardware → Agentes
-- → "Vincular nueva PC". Genera token aleatorio + crea row pre-vinculada.
-- El comerciante copia el token al instalador. En el primer heartbeat,
-- el agent reporta hostname/os/version y la row se completa.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_crear_print_agent_token(
  p_local_id INTEGER,
  p_nombre TEXT DEFAULT 'PC sin nombre'
) RETURNS TABLE (id BIGINT, agent_token TEXT)
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

  -- Validar que el local pertenece al tenant + el usuario lo ve
  IF NOT EXISTS (
    SELECT 1 FROM locales
    WHERE id = p_local_id
      AND tenant_id = v_tenant_id
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Token: 32 chars alfanuméricos, suficiente entropía. encode(gen_random_bytes(24),'hex')
  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO comanda_print_agents (tenant_id, local_id, agent_token, nombre)
  VALUES (v_tenant_id, p_local_id, v_token, COALESCE(NULLIF(trim(p_nombre), ''), 'PC sin nombre'))
  RETURNING comanda_print_agents.id INTO v_id;

  RETURN QUERY SELECT v_id, v_token;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_crear_print_agent_token(INTEGER, TEXT) TO authenticated;

-- ─── RPC: revocar agent (soft delete) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_revocar_print_agent(
  p_agent_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  SELECT local_id INTO v_local_id FROM comanda_print_agents
   WHERE id = p_agent_id AND tenant_id = v_tenant_id AND deleted_at IS NULL;
  IF v_local_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  UPDATE comanda_print_agents
     SET deleted_at = NOW(), updated_at = NOW()
   WHERE id = p_agent_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_revocar_print_agent(BIGINT) TO authenticated;

-- ─── Vista para UI admin ──────────────────────────────────────────────────
--
-- Agrupa agentes por local. Calcula "status" derivado:
--   - online    → last_seen_at < 3 min
--   - stale     → 3-15 min
--   - offline   → > 15 min o NULL
--
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_print_agents_status AS
SELECT
  a.id,
  a.tenant_id,
  a.local_id,
  l.nombre AS local_nombre,
  a.nombre,
  a.hostname,
  a.os_platform,
  a.agent_version,
  a.last_seen_at,
  a.printers_total,
  a.printers_online,
  a.queue_queued,
  a.queue_printing,
  a.queue_failed,
  a.queue_dead_letter,
  a.metadata,
  a.created_at,
  CASE
    WHEN a.last_seen_at IS NULL THEN 'never'
    WHEN a.last_seen_at > NOW() - INTERVAL '3 minutes' THEN 'online'
    WHEN a.last_seen_at > NOW() - INTERVAL '15 minutes' THEN 'stale'
    ELSE 'offline'
  END AS status
FROM comanda_print_agents a
LEFT JOIN locales l ON l.id = a.local_id
WHERE a.deleted_at IS NULL;

GRANT SELECT ON v_print_agents_status TO authenticated;

NOTIFY pgrst, 'reload schema';
