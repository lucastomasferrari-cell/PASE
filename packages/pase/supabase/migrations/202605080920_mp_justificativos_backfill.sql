-- ═══════════════════════════════════════════════════════════════════════════
-- MP justificativos — backfill comisiones (commit 3/5).
--
-- Marca las filas históricas tipo 'fee' (comisiones MP) y 'tax' (retenciones
-- impositivas) como auto-justificadas. Esas filas se generan al sincronizar
-- desde MP (vía _mp-payments-search.js) y nunca requieren conciliación
-- manual: son cargos automáticos, no transferencias del usuario.
--
-- justificativo_at queda NULL para diferenciar "auto-justificado por
-- backfill" de "auto-justificado al importar"; justificativo_por también
-- NULL (no hay usuario humano detrás de un cargo automático).
--
-- "retiro_automatico" NO se backfillea: la query exploratoria contra prod
-- (2026-05-08) no detectó ningún tipo de movimiento que claramente mapee
-- a un retiro automático a banco propio. Si MP empieza a reportarlos
-- separado en el futuro, agregar la regla acá o en el import.
--
-- Read-only para todo lo que no sea fee/tax — egresos manuales se quedan
-- sin justificar y aparecen en el KPI "Egresos sin justificar".
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE mp_movimientos
   SET justificativo_tipo = 'comision_mp'
 WHERE tipo IN ('fee', 'tax')
   AND justificativo_tipo IS NULL;

-- Reportar el conteo (visible en logs de migration al aplicar). El
-- DO $$...$$ es la única forma de hacer print desde una migration sql.
DO $$
DECLARE
  v_fee int;
  v_tax int;
  v_pending int;
BEGIN
  SELECT count(*) INTO v_fee
    FROM mp_movimientos
   WHERE tipo = 'fee' AND justificativo_tipo = 'comision_mp';
  SELECT count(*) INTO v_tax
    FROM mp_movimientos
   WHERE tipo = 'tax' AND justificativo_tipo = 'comision_mp';
  SELECT count(*) INTO v_pending
    FROM mp_movimientos
   WHERE monto < 0 AND anulado = false
     AND tipo NOT IN ('fee','tax')
     AND justificativo_tipo IS NULL;
  RAISE NOTICE '[mp_justificativos backfill] fee=%, tax=%, manuales pendientes=%',
    v_fee, v_tax, v_pending;
END$$;
