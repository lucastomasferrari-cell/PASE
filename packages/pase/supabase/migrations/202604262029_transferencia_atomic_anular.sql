-- ═══════════════════════════════════════════════════════════════════════════
-- Atomicidad de transferencias: anular cualquiera de los 2 movimientos
-- hermanos anula AMBOS y revierte los 2 saldos.
--
-- Estado anterior:
--   - transferencia_cuentas insertaba 2 movimientos sin link entre sí.
--   - anular_movimiento sólo anulaba el que el usuario tocaba; el otro
--     quedaba intacto y los saldos quedaban descuadrados.
--
-- Fix:
--   A. Columna nueva movimientos.transferencia_id uuid (nullable):
--      NULL = movimiento normal. Mismo uuid en 2 filas = pareja de
--      transferencia.
--   B. transferencia_cuentas genera un uuid y lo escribe en ambos INSERT.
--   C. anular_movimiento detecta transferencia_id; si está set, busca
--      todos los movs hermanos no anulados y los anula en bloque,
--      revirtiendo el saldo de cada uno.
--
-- Backfill: NO se hace heurístico para transferencias viejas (anteriores
-- a esta migration). Esos movs siguen sin transferencia_id y se anulan
-- uno a la vez como antes — no es ideal pero es seguro: linkear por
-- heurística (mismo monto / mismo detalle / mismo timestamp) podría
-- emparejar movimientos que NO son la misma transferencia.
-- ═══════════════════════════════════════════════════════════════════════════

-- A. Columna + índice parcial (sólo indexa filas con transferencia_id set).
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS transferencia_id uuid;

CREATE INDEX IF NOT EXISTS idx_movimientos_transferencia_id
  ON movimientos(transferencia_id) WHERE transferencia_id IS NOT NULL;

-- B. transferencia_cuentas — cuerpo idéntico al actual con los 2 INSERTs
--    aceptando transferencia_id = mismo uuid en las 2 filas.
CREATE OR REPLACE FUNCTION public.transferencia_cuentas(
  p_local_id integer,
  p_cuenta_origen text,
  p_cuenta_destino text,
  p_monto numeric,
  p_fecha date,
  p_detalle text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_mov_out text;
  v_mov_in text;
  v_detalle text;
  v_transf_id uuid := gen_random_uuid();
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta_origen IS NULL OR p_cuenta_origen = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_cuenta_destino IS NULL OR p_cuenta_destino = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_cuenta_origen = p_cuenta_destino THEN RAISE EXCEPTION 'CUENTAS_IGUALES'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);

  v_detalle := COALESCE(p_detalle, 'Transferencia ' || p_cuenta_origen || ' → ' || p_cuenta_destino);

  PERFORM _actualizar_saldo_caja(p_cuenta_origen, p_local_id, -p_monto);
  PERFORM _actualizar_saldo_caja(p_cuenta_destino, p_local_id, p_monto);

  v_mov_out := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id)
  VALUES (v_mov_out, p_fecha, p_cuenta_origen, 'Transferencia Salida', NULL,
    -p_monto, v_detalle, p_local_id, v_transf_id);

  v_mov_in := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id)
  VALUES (v_mov_in, p_fecha, p_cuenta_destino, 'Transferencia Entrada', NULL,
    p_monto, v_detalle, p_local_id, v_transf_id);

  PERFORM _auditar('movimientos', 'TRANSFERENCIA', jsonb_build_object(
    'mov_out', v_mov_out, 'mov_in', v_mov_in, 'monto', p_monto,
    'origen', p_cuenta_origen, 'destino', p_cuenta_destino,
    'transferencia_id', v_transf_id,
    'local_id', p_local_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('mov_out', v_mov_out, 'mov_in', v_mov_in, 'transferencia_id', v_transf_id);
END;
$function$;

-- C. anular_movimiento — si el mov tiene transferencia_id, anula también
--    al hermano (todos los movs con la misma transferencia_id no anulados).
--    Si no, comportamiento idéntico al anterior (un solo mov).
CREATE OR REPLACE FUNCTION public.anular_movimiento(
  p_mov_id text,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_mov RECORD;
  v_pareja RECORD;
  v_gasto_id text;
  v_anulados text[] := ARRAY[]::text[];
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  -- Si es parte de una transferencia, anular ambos movs hermanos.
  IF v_mov.transferencia_id IS NOT NULL THEN
    -- Validar autorización en el local del hermano también (pueden ser
    -- el mismo local en el modelo actual, pero por defensa-in-depth).
    FOR v_pareja IN
      SELECT * FROM movimientos
      WHERE transferencia_id = v_mov.transferencia_id
        AND anulado IS DISTINCT FROM TRUE
      ORDER BY id
    LOOP
      PERFORM _validar_local_autorizado(v_pareja.local_id);

      UPDATE movimientos
      SET anulado = true, anulado_motivo = p_motivo
      WHERE id = v_pareja.id;

      IF v_pareja.local_id IS NOT NULL THEN
        PERFORM _actualizar_saldo_caja(v_pareja.cuenta, v_pareja.local_id, -COALESCE(v_pareja.importe, 0));
      END IF;

      v_anulados := array_append(v_anulados, v_pareja.id);
    END LOOP;

    PERFORM _auditar('movimientos', 'ANULACION_TRANSFERENCIA', jsonb_build_object(
      'mov_id_solicitado', p_mov_id,
      'transferencia_id', v_mov.transferencia_id,
      'movs_anulados', to_jsonb(v_anulados),
      'motivo', p_motivo,
      'usuario_id', auth_usuario_id()
    ));

    RETURN jsonb_build_object(
      'mov_id', p_mov_id,
      'anulado', true,
      'transferencia_id', v_mov.transferencia_id,
      'movs_anulados', to_jsonb(v_anulados)
    );
  END IF;

  -- Flujo normal (movimiento único, sin pareja).
  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  -- Propagar anulación a rrhh_liquidaciones (idéntico a la versión previa).
  IF v_mov.liquidacion_id IS NOT NULL THEN
    UPDATE rrhh_liquidaciones SET anulado = true WHERE id = v_mov.liquidacion_id;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
    SELECT id INTO v_gasto_id FROM gastos
    WHERE detalle = v_mov.detalle AND fecha = v_mov.fecha
      AND cuenta = v_mov.cuenta AND local_id = v_mov.local_id
    LIMIT 1;
    IF v_gasto_id IS NOT NULL THEN
      UPDATE rrhh_liquidaciones SET anulado = true WHERE gasto_id = v_gasto_id;
    END IF;
  END IF;

  PERFORM _auditar('movimientos', 'ANULACION', jsonb_build_object(
    'mov_id', p_mov_id, 'motivo', p_motivo,
    'movimiento', to_jsonb(v_mov), 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$function$;
