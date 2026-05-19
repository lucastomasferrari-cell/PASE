-- ═══════════════════════════════════════════════════════════════════════════
-- Auto-fix de bugs vía Claude Agent SDK (Lucas 2026-05-19)
--
-- Extendemos tickets_soporte con columnas que tracckean el proceso del
-- agent autónomo (GitHub Actions runner). Estados posibles:
--
--   pending      → recién insertado, esperando que arranque el worker.
--   investigating → agent corriendo con Sonnet, leyendo código.
--   escalating   → Sonnet pidió ayuda a Opus. Opus retomó la investigación.
--   fixing       → agent escribiendo + testeando el fix.
--   pr_opened    → PR creado, esperando aprobación del superadmin.
--   resolved     → fix mergeado y deployado.
--   failed       → agent no pudo resolver (tests fallaron, paths no permitidos,
--                  o decidió rendirse). Volvió a la cola para humano.
--
-- El widget del cliente puede pollear `agent_status` para mostrar "En proceso"
-- mientras el bug se está atendiendo.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tickets_soporte
  ADD COLUMN IF NOT EXISTS agent_status TEXT CHECK (
    agent_status IN ('pending', 'investigating', 'escalating', 'fixing', 'pr_opened', 'resolved', 'failed')
  ),
  ADD COLUMN IF NOT EXISTS agent_pr_url TEXT,
  ADD COLUMN IF NOT EXISTS agent_pr_number INTEGER,
  ADD COLUMN IF NOT EXISTS agent_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_model_used TEXT,
  ADD COLUMN IF NOT EXISTS agent_cost_usd NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS agent_log JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_diff_summary TEXT;

-- Index para queries del Admin Console: "PRs pendientes de aprobación".
CREATE INDEX IF NOT EXISTS idx_tickets_soporte_agent_status
  ON tickets_soporte (agent_status, updated_at DESC)
  WHERE agent_status IN ('investigating', 'escalating', 'fixing', 'pr_opened');

-- ─── RPC para que el worker actualice el ticket sin RLS bloquear ──────────
-- El worker corre con SUPABASE_SERVICE_KEY (bypassa RLS) pero igual
-- centralizamos los updates en una RPC para mantener invariantes
-- (transiciones de estado válidas, append-only al log).
CREATE OR REPLACE FUNCTION agent_update_ticket(
  p_ticket_id    UUID,
  p_status       TEXT,
  p_log_entry    JSONB DEFAULT NULL,
  p_pr_url       TEXT DEFAULT NULL,
  p_pr_number    INTEGER DEFAULT NULL,
  p_model_used   TEXT DEFAULT NULL,
  p_cost_usd     NUMERIC DEFAULT NULL,
  p_diff_summary TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Solo callable por service_role. Si llega desde un user normal (con JWT),
  -- la GRANT de abajo impide la ejecución.
  UPDATE tickets_soporte
    SET agent_status = COALESCE(p_status, agent_status),
        agent_started_at = COALESCE(agent_started_at,
          CASE WHEN p_status = 'investigating' THEN v_now ELSE NULL END),
        agent_finished_at = CASE
          WHEN p_status IN ('resolved', 'failed', 'pr_opened') THEN v_now
          ELSE agent_finished_at
        END,
        agent_log = CASE
          WHEN p_log_entry IS NOT NULL
          THEN agent_log || jsonb_build_array(
            p_log_entry || jsonb_build_object('ts', v_now)
          )
          ELSE agent_log
        END,
        agent_pr_url = COALESCE(p_pr_url, agent_pr_url),
        agent_pr_number = COALESCE(p_pr_number, agent_pr_number),
        agent_model_used = COALESCE(p_model_used, agent_model_used),
        agent_cost_usd = COALESCE(agent_cost_usd, 0) + COALESCE(p_cost_usd, 0),
        agent_diff_summary = COALESCE(p_diff_summary, agent_diff_summary)
    WHERE id = p_ticket_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Solo service_role puede invocar. NO `authenticated` (sería un bypass de RLS).
REVOKE ALL ON FUNCTION agent_update_ticket(
  UUID, TEXT, JSONB, TEXT, INTEGER, TEXT, NUMERIC, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_update_ticket(
  UUID, TEXT, JSONB, TEXT, INTEGER, TEXT, NUMERIC, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';
