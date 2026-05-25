-- ─────────────────────────────────────────────────────────────────────────
-- Fix _resync_pago_especial: argumento debe ser UUID, no BIGINT
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug crítico descubierto 2026-05-25 corriendo el bloque defensivo de la
-- suite E2E. Test 19 (pagar_aguinaldo) fallaba con:
--   "function _resync_pago_especial(uuid) does not exist"
--
-- Mensaje engañoso: la función SÍ existe, pero declarada como
-- `_resync_pago_especial(p_pe_id BIGINT)`. La columna
-- `rrhh_pagos_especiales.id` es UUID (no bigint) y también
-- `movimientos.pago_especial_id_ref` es UUID. El trigger
-- `fn_trg_sync_pagos_rrhh` hace:
--   PERFORM _resync_pago_especial(NEW.pago_especial_id_ref);
-- Postgres busca `_resync_pago_especial(uuid)` → no existe la signatura
-- exacta (solo existe la `bigint`) → error.
--
-- Impacto operativo: **TODOS los pagos de aguinaldo / vacaciones /
-- liquidación final en producción FALLAN al insertar el movimiento del
-- pago** porque el trigger AFTER INSERT rebota con este error. Bug
-- introducido cuando alguien cambió `rrhh_pagos_especiales.id` de bigint
-- a uuid (probable migration histórica) pero olvidó actualizar la
-- signatura de esta función helper.
--
-- En PASE prod (Neko): el módulo de aguinaldo/vacaciones no se usaba
-- todavía en operación real, por eso nadie lo había detectado. El Test 19
-- lo expuso al ejercitar la RPC.
--
-- Fix:
-- 1. CREATE OR REPLACE con argumento UUID (crea nueva versión).
-- 2. DROP FUNCTION viejo (bigint) para no dejar 2 overloads que confundan
--    futuro mantenedores.
-- ─────────────────────────────────────────────────────────────────────────

-- Paso 1: crear versión correcta con UUID
CREATE OR REPLACE FUNCTION public._resync_pago_especial(p_pe_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
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

-- Paso 2: borrar la versión vieja (bigint) que nunca debería haber existido
DROP FUNCTION IF EXISTS public._resync_pago_especial(BIGINT);

COMMENT ON FUNCTION public._resync_pago_especial(UUID) IS
  'Recalcula monto_pagado/pendiente/pagado_at de un pago especial '
  '(aguinaldo/vacaciones/liquidación final) sumando los movimientos no '
  'anulados. Llamada desde trigger fn_trg_sync_pagos_rrhh AFTER INSERT/'
  'UPDATE/DELETE en movimientos. Fix 2026-05-25: arg ahora es UUID '
  '(antes era BIGINT, lo que rompía toda la cadena trigger → función).';
