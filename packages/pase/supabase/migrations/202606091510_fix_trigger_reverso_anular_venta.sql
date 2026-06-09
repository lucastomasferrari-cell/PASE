-- 202606091510_fix_trigger_reverso_anular_venta.sql
--
-- BUG (09-jun, descubierto por el ensayo general de COMANDA): al anular una
-- venta YA COBRADA, el ingreso quedaba en movimientos_caja SIN compensar →
-- la caja quedaba sobrestimada por una venta que ya no existe.
--
-- Causa: la función fn_trg_revertir_movimientos_al_anular_venta (que crea el
-- movimiento compensatorio -monto si hay turno abierto, o encola un
-- reverso_pendiente si no) EXISTÍA en la DB pero NO estaba conectada como
-- trigger en ventas_pos → nunca corría. El lado del "drenar al abrir turno"
-- (trg_drenar_reversos_al_abrir_turno en turnos_caja) sí estaba conectado, así
-- que con conectar este trigger el circuito completo queda cerrado:
--   anular venta cobrada → (turno abierto) mov compensatorio
--                        → (sin turno)     encola reverso_pendiente
--   abrir turno → trg_drenar drena el reverso → mov compensatorio.
--
-- Fix: (re)crear el trigger de encolado. La función ya tiene su propio guard
-- (OLD.estado='cobrada' AND NEW.estado='anulada'); el WHEN lo replica para no
-- invocarla de gusto.

DROP TRIGGER IF EXISTS trg_revertir_movimientos_anular_venta ON ventas_pos;
CREATE TRIGGER trg_revertir_movimientos_anular_venta
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  WHEN (NEW.estado = 'anulada' AND OLD.estado = 'cobrada')
  EXECUTE FUNCTION fn_trg_revertir_movimientos_al_anular_venta();

NOTIFY pgrst, 'reload schema';
