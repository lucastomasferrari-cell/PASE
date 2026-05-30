-- ─────────────────────────────────────────────────────────────────────────
-- RRHH adelantos — columna auto_aplicar (saldo flexible)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Contexto (Lucas 2026-05-30, bug recurrente con Maneki):
-- Cuando paga una quincena vieja y hay un adelanto del período actual que
-- cae dentro del rango de fechas del filtro, el sistema lo descuenta
-- obligatoriamente del pago. Anto necesita "saltearlo" porque planea
-- descontarlo en el próximo sueldo, no en el atrasado.
--
-- Solución "saldo flexible" (tipo nota de crédito a favor del empleador):
--   - Cada adelanto tiene una bandera auto_aplicar (default TRUE = comportamiento
--     histórico, no rompe nada).
--   - Al crear un adelanto, Anto puede dejarla OFF si todavía no quiere que
--     se descuente automáticamente.
--   - En el modal de pago de sueldo, los adelantos pendientes aparecen como
--     CHECKBOXES. Vienen pre-tildados los que tengan auto_aplicar=TRUE.
--     Anto puede destildar cualquiera para "dejarlo para la próxima".
--   - Solo los IDs tildados se envían a pagar_sueldo, que ya acepta el array
--     selectivo (p_adelantos_ids uuid[]) — el backend NO cambia.
--   - Los destildados quedan como descontado=false hasta el próximo pago.
--
-- Backward compat: TODAS las filas existentes quedan con auto_aplicar=TRUE
-- (DEFAULT). Comportamiento histórico preservado.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE rrhh_adelantos
  ADD COLUMN IF NOT EXISTS auto_aplicar BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN rrhh_adelantos.auto_aplicar IS
  'Si TRUE (default), el adelanto se pre-tilda en el modal de pago de sueldo cuando cae en el período. Si FALSE, queda como saldo flotante y solo se descuenta si el dueño lo tilda explícitamente.';
