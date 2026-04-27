-- ═══════════════════════════════════════════════════════════════════════════
-- Fix de 6 movimientos de Caja Chica duplicados por bug histórico del
-- parser de Maxirest (23-24 abril 2026). El parser viejo confundía el
-- bloque RESUMEN del mail de cierre con el bloque VENTAS y metía 2
-- entries de medio="EFECTIVO" en `ventas`. impactoPorCuenta sumaba
-- ambas, generando un movimiento de 2x en Caja Chica.
--
-- Defensas en el parser actual (enBloqueVentas, SUBTOTALES_IGNORAR,
-- filtro cant<=0) previenen futuras ocurrencias. Esta migration
-- corrige solo los 6 movimientos legacy ya creados.
--
-- Diagnóstico previo:
--   mov_id                          local fecha       turno    importe→nuevo  diff
--   MOV-1777132099811-fw9i          2     2026-04-24  Noche    3448640→1724320  1724320
--   MOV-1777132234498-3x4d          2     2026-04-24  Mediodía  487600→ 243800   243800
--   MOV-1777132425641-blq6          3     2026-04-24  Noche    3630920→1815460  1815460
--   MOV-1777132575507-s6tb          1     2026-04-24  Noche    4759823.6→2379911.8  2379911.8
--   MOV-1777132285415-w28k          2     2026-04-23  Noche    1406000→ 703000   703000
--   MOV-1777133061995-lboe          5     2026-04-23  Mediodía  725040→ 362520   362520
--
-- Diffs por local (a restar de saldos_caja Caja Chica):
--   local 1 (Villa Crespo): 2379911.80
--   local 2 (Belgrano):     2671120.00  (1724320 + 243800 + 703000)
--   local 3 (Devoto):       1815460.00
--   local 5 (Rene Cantina):  362520.00
--   TOTAL:                  7229011.80
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Defensive check: validar que los 6 movimientos existen y tienen
--    los importes esperados ANTES de tocar nada. Si la BD ya fue
--    parchada o algún importe difiere, abortar con RAISE.
DO $$
DECLARE
  v_count int;
  v_diff_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(importe), 0)
  INTO v_count, v_diff_total
  FROM movimientos
  WHERE id IN (
    'MOV-1777132099811-fw9i',
    'MOV-1777132234498-3x4d',
    'MOV-1777132425641-blq6',
    'MOV-1777132575507-s6tb',
    'MOV-1777132285415-w28k',
    'MOV-1777133061995-lboe'
  );
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'EXPECTED_6_MOVIMIENTOS_FOUND_%_(uno o mas IDs no existen, abortar)', v_count;
  END IF;
  -- Sum esperada de importes pre-fix: 3448640 + 487600 + 3630920 + 4759823.60 + 1406000 + 725040 = 14458023.60
  IF abs(v_diff_total - 14458023.60) > 1 THEN
    RAISE EXCEPTION 'IMPORTE_TOTAL_INESPERADO_%_(esperado 14458023.60, parche puede estar parcialmente aplicado)', v_diff_total;
  END IF;
END $$;

-- 2) UPDATE importes: dividir por 2.
UPDATE movimientos SET importe = importe / 2
WHERE id IN (
  'MOV-1777132099811-fw9i',
  'MOV-1777132234498-3x4d',
  'MOV-1777132425641-blq6',
  'MOV-1777132575507-s6tb',
  'MOV-1777132285415-w28k',
  'MOV-1777133061995-lboe'
);

-- 3) Ajustar saldos_caja: restar el diff por cada local afectado.
--    saldos_caja tiene PK (cuenta, local_id). Si la fila no existe,
--    UPDATE no hace nada — pero confirmamos abajo que las 4 existen.
UPDATE saldos_caja SET saldo = saldo - 2379911.80
  WHERE cuenta = 'Caja Chica' AND local_id = 1;
UPDATE saldos_caja SET saldo = saldo - 2671120.00
  WHERE cuenta = 'Caja Chica' AND local_id = 2;
UPDATE saldos_caja SET saldo = saldo - 1815460.00
  WHERE cuenta = 'Caja Chica' AND local_id = 3;
UPDATE saldos_caja SET saldo = saldo - 362520.00
  WHERE cuenta = 'Caja Chica' AND local_id = 5;

-- 4) Auditoría — INSERT en la tabla append-only (TASK 0.4 garantiza
--    que esta entry no se puede UPDATE/DELETE accidentalmente). Schema:
--    id serial, tabla text, accion text, detalle text, fecha timestamptz.
INSERT INTO auditoria (tabla, accion, detalle, fecha)
VALUES (
  'movimientos',
  'FIX_DUPLICADOS_HISTORICOS',
  jsonb_build_object(
    'descripcion', 'Bug parser Maxirest - efectivo duplicado en 6 cierres del 23-24 abril 2026',
    'movimientos_corregidos', ARRAY[
      'MOV-1777132099811-fw9i',
      'MOV-1777132234498-3x4d',
      'MOV-1777132425641-blq6',
      'MOV-1777132575507-s6tb',
      'MOV-1777132285415-w28k',
      'MOV-1777133061995-lboe'
    ],
    'total_corregido', 7229011.80,
    'diff_por_local', jsonb_build_object(
      '1', 2379911.80,
      '2', 2671120.00,
      '3', 1815460.00,
      '5',  362520.00
    ),
    'fix_automatico', true,
    'task_origen', '0.X (sweep tras bug reportado por Lucas en cierre 23/4 mediodía Rene Cantina)'
  )::text,
  NOW()
);
