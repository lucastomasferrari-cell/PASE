-- Idempotencia en crear_movimiento_caja (auditoría 01-ago, C1/C10)
-- ---------------------------------------------------------------------------
-- Bug: sin p_idempotency_key, un doble-click (o reintento tras respuesta
-- perdida) creaba DOS movimientos de caja reales. Se agrega la llave opcional
-- (compatible hacia atrás: NULL = comportamiento actual). movimientos ya tiene
-- índice único en idempotency_key → la carrera concurrente la corta el índice.
--
-- Nota: se DROPea la versión vieja de 7 args primero. Agregar un parámetro con
-- DEFAULT crea un OVERLOAD nuevo (no reemplaza), y dejar las dos hace ambigua la
-- llamada de 7 params del frontend. Con una sola versión, las llamadas viejas
-- resuelven a esta (el default llena p_idempotency_key).
DROP FUNCTION IF EXISTS public.crear_movimiento_caja(date, text, text, text, numeric, text, integer);

CREATE OR REPLACE FUNCTION public.crear_movimiento_caja(
  p_fecha date, p_cuenta text, p_tipo text, p_cat text, p_importe numeric,
  p_detalle text, p_local_id integer, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov_id text;
  v_tenant uuid;
  v_existing text;
BEGIN
  IF p_importe IS NULL OR p_importe = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  -- Idempotencia: si ya existe un movimiento con esta clave, devolverlo (replay).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM movimientos WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('mov_id', v_existing, 'idempotent_replay', true);
    END IF;
  END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;

  PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, p_importe);

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, idempotency_key)
  VALUES (v_mov_id, p_fecha, p_cuenta, p_tipo, p_cat, p_importe, p_detalle, p_local_id, v_tenant, p_idempotency_key);

  PERFORM _auditar('movimientos', 'CREAR', jsonb_build_object(
    'mov_id', v_mov_id, 'importe', p_importe, 'cuenta', p_cuenta,
    'local_id', p_local_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id);
EXCEPTION
  -- Carrera concurrente con la misma llave: el índice único la rechaza →
  -- devolvemos el movimiento que ganó (replay), sin duplicar.
  WHEN unique_violation THEN
    SELECT id INTO v_existing FROM movimientos WHERE idempotency_key = p_idempotency_key LIMIT 1;
    RETURN jsonb_build_object('mov_id', v_existing, 'idempotent_replay', true);
END;
$function$;
