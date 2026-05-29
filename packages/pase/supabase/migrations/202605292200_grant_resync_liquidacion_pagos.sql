-- ─────────────────────────────────────────────────────────────────────────
-- HOTFIX: GRANT EXECUTE en _resync_liquidacion_pagos al rol authenticated.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Reportado por Anto 29-may al intentar guardar pago de quincenas viejas:
--   "PERMISSION DENIED FOR FUNCTION RESYNC LIQUIDACION PAGOS"
--
-- Causa: la migration 202605270700 (audit_f1_criticos) recreó la función
-- como SECURITY DEFINER pero sin GRANT EXECUTE. La función la llama el
-- trigger fn_trg_sync_pagos_rrhh que se dispara al INSERT/UPDATE/DELETE
-- en movimientos. Cuando un user authenticated (Anto) inserta un mov,
-- el trigger ejecuta y necesita permiso para invocar _resync_liquidacion_pagos.
--
-- Fix: agregar GRANT EXECUTE TO authenticated. La función ya es
-- SECURITY DEFINER + owner postgres, así que la lógica interna corre
-- con privilegios elevados — el GRANT solo permite que un user authenticated
-- la pueda INVOCAR (no que tenga acceso a más cosas internas).
-- ─────────────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public._resync_liquidacion_pagos(uuid) TO authenticated;

COMMENT ON FUNCTION public._resync_liquidacion_pagos IS
  'Re-evalúa estado de liquidación según sus pagos efectivos. Llamada desde '
  'trigger fn_trg_sync_pagos_rrhh AFTER INSERT/UPDATE/DELETE en movimientos. '
  'Fix 29-may: agregado GRANT EXECUTE TO authenticated (sin esto fallaba con '
  'permission denied cualquier user al insertar movimientos ligados a sueldo).';
