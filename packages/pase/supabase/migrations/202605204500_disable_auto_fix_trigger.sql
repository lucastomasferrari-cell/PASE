-- ═══════════════════════════════════════════════════════════════════════════
-- Deshabilitar auto-fix agent — decisión Lucas 2026-05-20
--
-- Razón: el agent gastaba $0.50-$3 USD por bug y muchas veces resolvía
-- mal (ej. ticket Anto: identificó "falta permiso rrhh" cuando la causa
-- real era una FK rota). Lucas prefiere que los tickets entren a la DB,
-- le notifiquen, y los resuelva manualmente con claude-code que puede
-- inspeccionar todo el contexto.
--
-- Cambio: el trigger fn `_on_ticket_inserted_dispatch_agent` deja de
-- llamar `dispatch_auto_fix_workflow`. En su lugar, marca el ticket como
-- `agent_status='disabled'` para que el widget UI muestre "pendiente de
-- revisión humana" en vez de "en cola".
--
-- Si Lucas quiere reactivar en el futuro: rerun de la migration original
-- 202605201600_auto_fix_trigger.sql (que crea la versión que dispara).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _on_ticket_inserted_dispatch_agent()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- AUTO-FIX DESHABILITADO (2026-05-20):
  -- Antes acá se llamaba dispatch_auto_fix_workflow(NEW.id) para
  -- categoria='bug'. Ahora solo marca el ticket para que la UI sepa
  -- que el bot no lo va a tomar.
  IF NEW.categoria = 'bug' AND NEW.agent_status IS NULL THEN
    NEW.agent_status := 'disabled';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
