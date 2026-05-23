-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: tickets_soporte.agent_status CHECK no acepta 'disabled'
--
-- Bug reportado por Lucas el 22-may noche (chat soporte tira error con
-- "item creo"): TODO ticket categoria='bug' falla con
--   "violates check constraint tickets_soporte_agent_status_check"
-- porque el trigger _on_ticket_inserted_dispatch_agent setea
-- `agent_status := 'disabled'` (migration 202605204500) pero el CHECK
-- creado en 202605201500 solo acepta {pending, investigating, escalating,
-- fixing, pr_opened, resolved, failed}.
--
-- Significa que desde el 20-may noche TODOS los reportes de bug desde el
-- widget de soporte estuvieron fallando silenciosamente.
--
-- Fix: agregar 'disabled' al array del CHECK.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tickets_soporte
  DROP CONSTRAINT IF EXISTS tickets_soporte_agent_status_check;

ALTER TABLE tickets_soporte
  ADD CONSTRAINT tickets_soporte_agent_status_check CHECK (
    agent_status IS NULL OR agent_status IN (
      'pending', 'investigating', 'escalating', 'fixing',
      'pr_opened', 'resolved', 'failed', 'disabled'
    )
  );

NOTIFY pgrst, 'reload schema';
