-- Fix: Argañaraz Camilo Nicolas mayo 2026 — el movimiento repartido a Devoto
-- quedó anulado por error durante los múltiples intentos de pago del 7-jun.
-- pagos_realizados quedó en $480,179 (corrupto). Desanulamos el repartido
-- y resincronizamos para que la liquidación quede completa ($1,653,333).

BEGIN;

-- 1) Desanular el movimiento repartido de Devoto ($586,577)
--    Identificado por: liq_id + created_at batch 2 + importe exacto + local 3
UPDATE movimientos
SET anulado = false,
    anulado_motivo = NULL
WHERE id = 'MOV-1780864404-15b6'
  AND anulado = true;

-- 2) Resincronizar pagos_realizados desde movimientos activos
SELECT _resync_liquidacion_pagos('44024771-b323-44bb-a8bc-1e3e27ba6b09');

-- 3) Verificación: debe dar pagos=1653333, estado=pagado
DO $$
DECLARE
  v_pagos numeric;
  v_estado text;
BEGIN
  SELECT pagos_realizados, estado INTO v_pagos, v_estado
  FROM rrhh_liquidaciones WHERE id = '44024771-b323-44bb-a8bc-1e3e27ba6b09';

  IF v_pagos <> 1653333 THEN
    RAISE EXCEPTION 'VERIFICACION FALLÓ: pagos_realizados=% (esperado 1653333)', v_pagos;
  END IF;
  IF v_estado <> 'pagado' THEN
    RAISE EXCEPTION 'VERIFICACION FALLÓ: estado=% (esperado pagado)', v_estado;
  END IF;

  RAISE NOTICE 'OK: pagos_realizados=%, estado=%', v_pagos, v_estado;
END $$;

COMMIT;
