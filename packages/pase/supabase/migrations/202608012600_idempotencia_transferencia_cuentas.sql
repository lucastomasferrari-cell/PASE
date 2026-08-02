-- Idempotencia en transferencia_cuentas (auditoría 01-ago, C1/C10)
-- ---------------------------------------------------------------------------
-- Doble-click hacía dos transferencias reales. Se agrega p_idempotency_key: la
-- llave va en el movimiento de SALIDA (el índice único de movimientos.idempotency_key
-- solo permite una fila con esa llave; el de entrada no la lleva). En replay se
-- busca el par por transferencia_id. Se dropea el overload viejo de 7 args.

DROP FUNCTION IF EXISTS public.transferencia_cuentas(integer, text, text, numeric, date, text, integer);

CREATE OR REPLACE FUNCTION public.transferencia_cuentas(
  p_local_id integer, p_cuenta_origen text, p_cuenta_destino text, p_monto numeric,
  p_fecha date, p_detalle text DEFAULT NULL::text, p_local_destino_id integer DEFAULT NULL::integer,
  p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov_out text; v_mov_in text; v_detalle text;
  v_transf_id uuid := gen_random_uuid(); v_tenant uuid;
  v_tenant_destino uuid;
  v_local_dst integer;
  v_cross_local boolean;
  v_nombre_origen text;
  v_nombre_destino text;
  v_ex_out text; v_ex_in text; v_ex_transf uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta_origen IS NULL OR p_cuenta_origen = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_cuenta_destino IS NULL OR p_cuenta_destino = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  -- Idempotencia: replay si ya existe la transferencia con esta llave.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, transferencia_id INTO v_ex_out, v_ex_transf
      FROM movimientos WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_ex_out IS NOT NULL THEN
      SELECT id INTO v_ex_in FROM movimientos WHERE transferencia_id = v_ex_transf AND id <> v_ex_out LIMIT 1;
      RETURN jsonb_build_object('mov_out', v_ex_out, 'mov_in', v_ex_in,
        'transferencia_id', v_ex_transf, 'idempotent_replay', true);
    END IF;
  END IF;

  v_local_dst := COALESCE(p_local_destino_id, p_local_id);
  v_cross_local := (v_local_dst <> p_local_id);

  IF NOT v_cross_local AND p_cuenta_origen = p_cuenta_destino THEN
    RAISE EXCEPTION 'CUENTAS_IGUALES';
  END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  IF v_cross_local THEN
    PERFORM _validar_local_autorizado(v_local_dst);
  END IF;

  SELECT tenant_id, nombre INTO v_tenant, v_nombre_origen FROM locales WHERE id = p_local_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO'; END IF;

  IF v_cross_local THEN
    SELECT tenant_id, nombre INTO v_tenant_destino, v_nombre_destino FROM locales WHERE id = v_local_dst;
    IF v_tenant_destino IS NULL THEN RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO'; END IF;
    IF v_tenant_destino <> v_tenant THEN
      RAISE EXCEPTION 'TENANT_MISMATCH';
    END IF;
  ELSE
    v_nombre_destino := v_nombre_origen;
  END IF;

  IF p_detalle IS NOT NULL AND p_detalle <> '' THEN
    v_detalle := p_detalle;
  ELSIF v_cross_local THEN
    v_detalle := 'Transferencia ' || v_nombre_origen || ' (' || p_cuenta_origen || ') → '
              || v_nombre_destino || ' (' || p_cuenta_destino || ')';
  ELSE
    v_detalle := 'Transferencia ' || p_cuenta_origen || ' → ' || p_cuenta_destino;
  END IF;

  PERFORM _actualizar_saldo_caja(p_cuenta_origen, p_local_id, -p_monto);
  PERFORM _actualizar_saldo_caja(p_cuenta_destino, v_local_dst, p_monto);

  -- Movimiento de salida (lleva la llave de idempotencia).
  v_mov_out := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id, tenant_id, idempotency_key)
  VALUES (v_mov_out, p_fecha, p_cuenta_origen, 'Transferencia Salida', NULL,
    -p_monto, v_detalle, p_local_id, v_transf_id, v_tenant, p_idempotency_key);

  -- Movimiento de entrada (sin llave; el índice único solo permite una).
  v_mov_in := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id, tenant_id)
  VALUES (v_mov_in, p_fecha, p_cuenta_destino, 'Transferencia Entrada', NULL,
    p_monto, v_detalle, v_local_dst, v_transf_id, v_tenant);

  PERFORM _auditar('movimientos', 'TRANSFERENCIA', jsonb_build_object(
    'mov_out', v_mov_out, 'mov_in', v_mov_in, 'monto', p_monto,
    'origen', p_cuenta_origen, 'destino', p_cuenta_destino,
    'local_origen', p_local_id, 'local_destino', v_local_dst,
    'cross_local', v_cross_local,
    'transferencia_id', v_transf_id,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object(
    'mov_out', v_mov_out,
    'mov_in', v_mov_in,
    'transferencia_id', v_transf_id,
    'cross_local', v_cross_local
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, transferencia_id INTO v_ex_out, v_ex_transf
      FROM movimientos WHERE idempotency_key = p_idempotency_key LIMIT 1;
    SELECT id INTO v_ex_in FROM movimientos WHERE transferencia_id = v_ex_transf AND id <> v_ex_out LIMIT 1;
    RETURN jsonb_build_object('mov_out', v_ex_out, 'mov_in', v_ex_in,
      'transferencia_id', v_ex_transf, 'idempotent_replay', true);
END;
$function$;
