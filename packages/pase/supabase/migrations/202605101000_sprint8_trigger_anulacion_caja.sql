-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 8 — Tarea 1
--
-- Trigger AFTER UPDATE en ventas_pos: cuando una venta cobrada se anula,
-- inserta movimientos compensatorios (tipo='venta_anulada' con monto
-- negativo) en el turno abierto del local.
--
-- Sin esto, anular una venta cobrada deja la caja con dinero "fantasma":
-- los movimientos del cobro original quedan en movimientos_caja pero
-- nada los compensa. El cierre de turno con arqueo da diferencia.
--
-- Diseño:
--   - Solo dispara cuando estado pasa de 'cobrada' → 'anulada'.
--   - Por cada pago confirmado (ventas_pos_pagos.estado='confirmado')
--     genera 1 movimiento_caja con tipo='venta_anulada' y monto negativo.
--   - Usa el turno abierto actual del local (no el turno_caja_id de la
--     venta original — puede que ya esté cerrado).
--   - Si no hay turno abierto, RAISE NOTICE y NO inserta. La diferencia
--     queda como deuda (próximo sprint: cola de reversos pendientes).
--   - idempotency_key derivado 'reverso_<venta_id>_<pago_id>': si el
--     trigger se reejecuta (re-anular venta ya anulada), no duplica.
--
-- Tipo 'venta_anulada' ya existía en el CHECK de movimientos_caja
-- (sprint 2). turnosCajaService.totalesPorMetodo ya lo trata como
-- signo negativo. No hace falta tocar el constraint.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_trg_revertir_movimientos_al_anular_venta()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pago RECORD;
  v_turno_id BIGINT;
  v_empleado UUID;
BEGIN
  -- Solo actuar si pasó de 'cobrada' → 'anulada'.
  IF NEW.estado != 'anulada' OR OLD.estado != 'cobrada' THEN
    RETURN NEW;
  END IF;

  -- Buscar turno abierto del local. Si no hay, salir sin error
  -- (la diferencia se ajusta manualmente vía Settings → Auditoría).
  SELECT id INTO v_turno_id
  FROM turnos_caja
  WHERE local_id = NEW.local_id AND estado = 'abierto'
  LIMIT 1;

  IF v_turno_id IS NULL THEN
    RAISE NOTICE 'Anulación venta % sin turno abierto: no se generan movimientos compensatorios', NEW.id;
    RETURN NEW;
  END IF;

  -- empleado_id requerido por NOT NULL en movimientos_caja: usamos el
  -- cajero original de la venta. Si no hay, el cajero del turno abierto.
  v_empleado := NEW.cajero_id;
  IF v_empleado IS NULL THEN
    SELECT cajero_id INTO v_empleado FROM turnos_caja WHERE id = v_turno_id;
  END IF;

  -- Por cada pago confirmado, insertar movimiento negativo.
  FOR v_pago IN
    SELECT id, metodo, monto, cobrado_por
    FROM ventas_pos_pagos
    WHERE venta_id = NEW.id
      AND estado = 'confirmado'
      AND deleted_at IS NULL
  LOOP
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id,
      tipo, monto, metodo, motivo, venta_id,
      idempotency_key
    ) VALUES (
      NEW.tenant_id, NEW.local_id, v_turno_id,
      COALESCE(v_pago.cobrado_por, v_empleado),
      'venta_anulada',
      -ABS(v_pago.monto),
      v_pago.metodo,
      'Reverso automático por anulación de venta #' || NEW.numero_local,
      NEW.id,
      'reverso_' || NEW.id || '_' || v_pago.id
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revertir_movimientos_al_anular ON ventas_pos;
CREATE TRIGGER trg_revertir_movimientos_al_anular
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_revertir_movimientos_al_anular_venta();

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN sprint 8 tarea 1
-- ═══════════════════════════════════════════════════════════════════════════
