-- ═══════════════════════════════════════════════════════════════════════════
-- Fix tolerancia de centavos en trigger sync pagos RRHH
--
-- Bug encontrado al aplicar el backfill (22-may noche, Marcelo): la
-- liquidación de Marcelo tiene total_a_pagar=1041021 (entero, según
-- el código JS que hace Math.round) pero la suma de pagos es 1041020.83
-- (los movimientos guardan decimales). La diferencia de $0.17 hacía
-- que el trigger dejara la liquidación como 'pendiente' aunque
-- prácticamente estuviera pagada.
--
-- Fix: tolerancia de $1 peso. Si pagos >= (total - 1), la consideramos
-- pagada. Mismo criterio para pagos especiales.
-- ═══════════════════════════════════════════════════════════════════════════

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

  SELECT COALESCE(SUM(-importe), 0) INTO v_pagado
    FROM movimientos
    WHERE liquidacion_id = p_liq_id
      AND COALESCE(anulado, false) = false;

  -- Tolerancia de $1 peso: si pagos >= (total - 1), consideramos pagada.
  -- Cubre el caso de redondeo cuando total_a_pagar es int y los pagos
  -- tienen decimales.
  v_completa := v_pagado >= (v_total - 1);

  UPDATE rrhh_liquidaciones
    SET pagos_realizados = v_pagado,
        estado = CASE WHEN v_completa THEN 'pagado' ELSE 'pendiente' END,
        pagado_at = CASE WHEN v_completa THEN COALESCE(pagado_at, NOW()) ELSE NULL END,
        pagado_por = CASE WHEN v_completa THEN pagado_por ELSE NULL END
    WHERE id = p_liq_id;
END;
$$;

CREATE OR REPLACE FUNCTION _resync_pago_especial(p_pe_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_monto NUMERIC;
  v_pagado NUMERIC;
  v_completa BOOLEAN;
BEGIN
  IF p_pe_id IS NULL THEN RETURN; END IF;

  SELECT monto INTO v_monto
    FROM rrhh_pagos_especiales WHERE id = p_pe_id;
  IF v_monto IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(-importe), 0) INTO v_pagado
    FROM movimientos
    WHERE pago_especial_id_ref = p_pe_id
      AND COALESCE(anulado, false) = false;

  v_completa := v_pagado >= (v_monto - 1);

  UPDATE rrhh_pagos_especiales
    SET monto_pagado = v_pagado,
        pendiente = NOT v_completa,
        pagado_at = CASE WHEN v_completa THEN COALESCE(pagado_at, NOW()) ELSE NULL END,
        pagado_por = CASE WHEN v_completa THEN pagado_por ELSE NULL END
    WHERE id = p_pe_id;
END;
$$;

-- Re-aplicar backfill con la nueva tolerancia para corregir liquidaciones
-- que quedaron como 'pendiente' por centavos.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT liquidacion_id FROM movimientos WHERE liquidacion_id IS NOT NULL
  LOOP
    PERFORM _resync_liquidacion_pagos(r.liquidacion_id);
  END LOOP;
  FOR r IN SELECT DISTINCT pago_especial_id_ref FROM movimientos WHERE pago_especial_id_ref IS NOT NULL
  LOOP
    PERFORM _resync_pago_especial(r.pago_especial_id_ref);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
