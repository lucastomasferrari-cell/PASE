-- ═══════════════════════════════════════════════════════════════════════════
-- Cleanup: monto_bruto en egresos debe tener el mismo signo que monto.
--
-- Bug encontrado en producción 2026-05-02 por Lucas:
--   mapPaymentToRows emitía monto_bruto = +Math.abs(transaction_amount)
--   siempre, sin importar si era ingreso o egreso. Para ingresos era OK
--   (monto positivo, monto_bruto positivo). Para egresos quedaba inconsistente
--   (monto negativo, monto_bruto positivo) y SUM(monto_bruto) sobre rows
--   mezcladas inflaba el total porque restaba el ingreso bruto pero sumaba
--   el egreso bruto en vez de restarlo.
--
-- Ejemplos reportados (12/04 al 02/05):
--   - "Varios"        $650.000   monto=-650000  monto_bruto=+650000 → fix
--   - "Salsa Kimchi"  $85.320    monto=-85320   monto_bruto=+85320  → fix
--   - "Aysa"          $73.928    monto=-73928   monto_bruto=+73928  → fix
--
-- Fix de código en mismo commit:
--   - api/_mp-payments-search.js mapPaymentToRows ahora emite monto_bruto
--     con sign matching monto (negativo si egreso).
--   - api/mp-update-pending-releases.js update path infiere sign desde el
--     candidate.monto existente (no pega a MP por ourAccountId).
--
-- Esta migration corrige las filas históricas. Idempotente: solo afecta filas
-- con monto<0 AND monto_bruto>0.
--
-- Scope intencional:
--   - Solo prefijo pay-% (la única tabla afectada por el bug — fee/tax tienen
--     monto negativo y NO emiten monto_bruto, queda NULL).
--   - Sin filtro de tenant ni local — bug global, fix global.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE mp_movimientos
SET monto_bruto = -monto_bruto
WHERE id LIKE 'pay-%'
  AND monto < 0
  AND monto_bruto > 0;

-- Sanity check post-update: ya no deberían quedar pay-* con sign mismatch.
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM mp_movimientos
  WHERE id LIKE 'pay-%'
    AND ((monto < 0 AND monto_bruto > 0) OR (monto > 0 AND monto_bruto < 0));
  IF remaining > 0 THEN
    RAISE WARNING 'mp_movimientos: % filas pay-% con sign mismatch tras cleanup', remaining;
  END IF;
END $$;
