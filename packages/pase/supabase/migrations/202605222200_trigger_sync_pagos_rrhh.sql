-- ═══════════════════════════════════════════════════════════════════════════
-- Trigger sistémico: sincronizar pagos RRHH cuando se edita un movimiento
--
-- Bug descubierto 22-may noche (deuda C4-F15): Lucas editó el importe
-- de un movimiento de Pago Sueldo de Marcelo desde la pantalla de Caja
-- (motivo "mal cargado") y bajó el monto. La pantalla de Caja respetó la
-- edición, pero la tabla rrhh_liquidaciones quedó con pagos_realizados
-- ANTIGUO (el monto antes de editar) → la UI de Pagos seguía mostrando
-- la liquidación como casi-cobrada cuando en realidad faltaban \$350K.
--
-- Este trigger garantiza la consistencia automática:
-- - Cuando se INSERT/UPDATE/DELETE un movimiento con liquidacion_id:
--     recalcula pagos_realizados y estado en rrhh_liquidaciones
-- - Cuando se INSERT/UPDATE/DELETE un movimiento con pago_especial_id_ref:
--     recalcula monto_pagado y pendiente en rrhh_pagos_especiales
--
-- Diseño:
-- - Triggers AFTER (no BEFORE) — solo reaccionamos a cambios consumados
-- - Usamos OLD y NEW para detectar cambios de liquidacion_id (raro pero posible)
-- - No bloqueamos nada, solo sincronizamos
-- - Si el movimiento se anula (anulado=true), restamos su contribución
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Función helper: recalcular pagos de una liquidación ───────────────
CREATE OR REPLACE FUNCTION _resync_liquidacion_pagos(p_liq_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC;
  v_pagado NUMERIC;
  v_completa BOOLEAN;
BEGIN
  IF p_liq_id IS NULL THEN RETURN; END IF;

  SELECT total_a_pagar INTO v_total
    FROM rrhh_liquidaciones WHERE id = p_liq_id;
  IF v_total IS NULL THEN RETURN; END IF;

  -- Suma de movimientos no anulados (importe es negativo en los egresos →
  -- el pago real es -importe).
  SELECT COALESCE(SUM(-importe), 0) INTO v_pagado
    FROM movimientos
    WHERE liquidacion_id = p_liq_id
      AND COALESCE(anulado, false) = false;

  v_completa := v_pagado >= v_total;

  UPDATE rrhh_liquidaciones
    SET pagos_realizados = v_pagado,
        estado = CASE WHEN v_completa THEN 'pagado' ELSE 'pendiente' END,
        -- Si pasa de pagado a pendiente, limpiar timestamps de pago
        pagado_at = CASE WHEN v_completa THEN COALESCE(pagado_at, NOW()) ELSE NULL END,
        pagado_por = CASE WHEN v_completa THEN pagado_por ELSE NULL END
    WHERE id = p_liq_id;
END;
$$;

-- ─── 2. Función helper: recalcular pagos especiales ───────────────────────
CREATE OR REPLACE FUNCTION _resync_pago_especial(p_pe_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_monto NUMERIC;
  v_pagado NUMERIC;
BEGIN
  IF p_pe_id IS NULL THEN RETURN; END IF;

  SELECT monto INTO v_monto
    FROM rrhh_pagos_especiales WHERE id = p_pe_id;
  IF v_monto IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(-importe), 0) INTO v_pagado
    FROM movimientos
    WHERE pago_especial_id_ref = p_pe_id
      AND COALESCE(anulado, false) = false;

  UPDATE rrhh_pagos_especiales
    SET monto_pagado = v_pagado,
        pendiente = (v_pagado < v_monto),
        pagado_at = CASE WHEN v_pagado >= v_monto THEN COALESCE(pagado_at, NOW()) ELSE NULL END,
        pagado_por = CASE WHEN v_pagado >= v_monto THEN pagado_por ELSE NULL END
    WHERE id = p_pe_id;
END;
$$;

-- ─── 3. Trigger en movimientos ────────────────────────────────────────────
-- Se dispara después de INSERT, UPDATE de (importe, anulado, liquidacion_id,
-- pago_especial_id_ref) o DELETE. Sincroniza ambas tablas según cuál(es)
-- referencias tenga el movimiento.

CREATE OR REPLACE FUNCTION fn_trg_sync_pagos_rrhh()
RETURNS TRIGGER LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT: sincronizamos las referencias del nuevo movimiento.
  IF TG_OP = 'INSERT' THEN
    IF NEW.liquidacion_id IS NOT NULL THEN
      PERFORM _resync_liquidacion_pagos(NEW.liquidacion_id);
    END IF;
    IF NEW.pago_especial_id_ref IS NOT NULL THEN
      PERFORM _resync_pago_especial(NEW.pago_especial_id_ref);
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: sincronizamos las referencias del movimiento borrado.
  IF TG_OP = 'DELETE' THEN
    IF OLD.liquidacion_id IS NOT NULL THEN
      PERFORM _resync_liquidacion_pagos(OLD.liquidacion_id);
    END IF;
    IF OLD.pago_especial_id_ref IS NOT NULL THEN
      PERFORM _resync_pago_especial(OLD.pago_especial_id_ref);
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: si cambió liquidacion_id, sincronizar ambas (vieja + nueva).
  -- Si cambió pago_especial_id_ref, idem.
  -- También cuando solo cambia importe o anulado, sincronizar la actual.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.liquidacion_id IS DISTINCT FROM NEW.liquidacion_id THEN
      PERFORM _resync_liquidacion_pagos(OLD.liquidacion_id);
      PERFORM _resync_liquidacion_pagos(NEW.liquidacion_id);
    ELSIF NEW.liquidacion_id IS NOT NULL AND (
      OLD.importe IS DISTINCT FROM NEW.importe OR
      OLD.anulado IS DISTINCT FROM NEW.anulado
    ) THEN
      PERFORM _resync_liquidacion_pagos(NEW.liquidacion_id);
    END IF;

    IF OLD.pago_especial_id_ref IS DISTINCT FROM NEW.pago_especial_id_ref THEN
      PERFORM _resync_pago_especial(OLD.pago_especial_id_ref);
      PERFORM _resync_pago_especial(NEW.pago_especial_id_ref);
    ELSIF NEW.pago_especial_id_ref IS NOT NULL AND (
      OLD.importe IS DISTINCT FROM NEW.importe OR
      OLD.anulado IS DISTINCT FROM NEW.anulado
    ) THEN
      PERFORM _resync_pago_especial(NEW.pago_especial_id_ref);
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_pagos_rrhh ON movimientos;
CREATE TRIGGER trg_sync_pagos_rrhh
  AFTER INSERT OR UPDATE OR DELETE ON movimientos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_sync_pagos_rrhh();

-- ─── 4. Backfill defensivo ───────────────────────────────────────────────
-- Re-sincronizar TODAS las liquidaciones y pagos especiales para que el
-- estado actual quede coherente con los movimientos (corrige cualquier
-- desbalance histórico que pueda haber por ediciones manuales previas).

DO $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
  v_count_pe INTEGER := 0;
BEGIN
  -- Liquidaciones que tienen al menos un movimiento referenciándolas
  FOR r IN
    SELECT DISTINCT liquidacion_id FROM movimientos WHERE liquidacion_id IS NOT NULL
  LOOP
    PERFORM _resync_liquidacion_pagos(r.liquidacion_id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT DISTINCT pago_especial_id_ref FROM movimientos WHERE pago_especial_id_ref IS NOT NULL
  LOOP
    PERFORM _resync_pago_especial(r.pago_especial_id_ref);
    v_count_pe := v_count_pe + 1;
  END LOOP;

  RAISE NOTICE 'Backfill: % liquidaciones + % pagos especiales resincronizados', v_count, v_count_pe;
END $$;

NOTIFY pgrst, 'reload schema';
