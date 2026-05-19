-- ═══════════════════════════════════════════════════════════════════════════
-- Trigger Postgres: dispara GitHub Actions cuando entra un ticket de bug.
--
-- Lucas 2026-05-19: para no consumir otra Vercel function (estamos en 12/12),
-- el disparo del workflow auto-fix-bug.yml se hace directo desde Postgres
-- vía la extensión pg_net (HTTP cliente). El trigger se activa solo si
-- categoria='bug', evitando disparar el agent por dudas operativas comunes.
--
-- Secreto requerido en Supabase Vault:
--   github_pat_for_dispatch: Personal Access Token con scope `repo` para
--   poder llamar a POST /repos/{owner}/{repo}/dispatches. Configurar desde
--   el panel Supabase → Database → Vault → Add new secret.
--
-- Si pg_net o el secreto no están configurados, el trigger NO falla la
-- inserción del ticket — loguea un warning y sigue. El ticket queda en
-- la cola para atención humana manual.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Habilitar pg_net si no está ───────────────────────────────────────
-- (En Supabase viene instalada por default — esto es defense-in-depth.)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ─── 2. Función que dispara el workflow ───────────────────────────────────
CREATE OR REPLACE FUNCTION dispatch_auto_fix_workflow(p_ticket_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_token TEXT;
  v_repo  TEXT := 'lucastomasferrari-cell/PASE';
  v_response_id BIGINT;
BEGIN
  -- Leer PAT desde Supabase Vault. Si no existe el secret, salimos sin error
  -- para no bloquear el INSERT del ticket.
  BEGIN
    SELECT decrypted_secret INTO v_token
      FROM vault.decrypted_secrets
     WHERE name = 'github_pat_for_dispatch'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_token := NULL;
  END;

  IF v_token IS NULL OR length(trim(v_token)) = 0 THEN
    RAISE WARNING 'github_pat_for_dispatch no configurado en Vault — auto-fix saltado para ticket %', p_ticket_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'pat_missing');
  END IF;

  -- Disparar repository_dispatch event en GitHub.
  SELECT net.http_post(
    url := 'https://api.github.com/repos/' || v_repo || '/dispatches',
    headers := jsonb_build_object(
      'Accept', 'application/vnd.github+json',
      'Authorization', 'Bearer ' || v_token,
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      'User-Agent', 'pase-auto-fix-trigger'
    ),
    body := jsonb_build_object(
      'event_type', 'auto_fix_bug',
      'client_payload', jsonb_build_object('ticket_id', p_ticket_id::text)
    )
  ) INTO v_response_id;

  RETURN jsonb_build_object('ok', true, 'response_id', v_response_id);
END;
$$;

REVOKE ALL ON FUNCTION dispatch_auto_fix_workflow(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dispatch_auto_fix_workflow(UUID) TO service_role;

-- ─── 3. Trigger en tickets_soporte ────────────────────────────────────────
CREATE OR REPLACE FUNCTION _on_ticket_inserted_dispatch_agent()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo disparamos para tickets categoría 'bug'. Para 'duda'/'feature'/'otro'
  -- el LLM ya respondió en el widget — no tiene sentido invocar al agent
  -- a leer código. Si Lucas quiere atender una duda con código,
  -- la reclasifica como bug desde el Admin Console y se vuelve a disparar
  -- (vía UPDATE trigger — pendiente, ver migration futura si hace falta).
  IF NEW.categoria = 'bug' AND NEW.agent_status IS NULL THEN
    BEGIN
      PERFORM dispatch_auto_fix_workflow(NEW.id);
      -- Marcar como 'pending' para que el widget muestre "En proceso"
      -- mientras el worker arranca (puede tardar 30-60s en bootear el runner).
      NEW.agent_status := 'pending';
    EXCEPTION WHEN OTHERS THEN
      -- No bloqueamos el INSERT del ticket si el dispatch falla.
      RAISE WARNING 'dispatch_auto_fix_workflow falló: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_inserted_dispatch_agent ON tickets_soporte;
CREATE TRIGGER trg_ticket_inserted_dispatch_agent
  BEFORE INSERT ON tickets_soporte
  FOR EACH ROW
  EXECUTE FUNCTION _on_ticket_inserted_dispatch_agent();

NOTIFY pgrst, 'reload schema';
