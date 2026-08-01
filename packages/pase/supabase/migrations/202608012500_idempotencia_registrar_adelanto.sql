-- Idempotencia en registrar_adelanto (auditoría 01-ago, C1/C10)
-- ---------------------------------------------------------------------------
-- Doble-click creaba dos adelantos + dos movimientos (doble descuento del sueldo
-- futuro + caja debitada dos veces). Se agrega p_idempotency_key opcional; el
-- movimiento lleva la llave (índice único), y en replay se devuelve el existente.
-- Se dropea el overload viejo de 5 args para no dejar ambigua la llamada.

DROP FUNCTION IF EXISTS public.registrar_adelanto(uuid, numeric, text, date, text);

CREATE OR REPLACE FUNCTION public.registrar_adelanto(
  p_empleado_id uuid, p_monto numeric, p_cuenta text, p_fecha date,
  p_detalle text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_mov_id text; v_adel_id uuid; v_detalle text;
  v_tenant uuid; v_ex_mov text; v_ex_adel uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  -- Idempotencia: replay si ya existe el movimiento con esta llave.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, adelanto_id_ref INTO v_ex_mov, v_ex_adel
      FROM movimientos WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_ex_mov IS NOT NULL THEN
      RETURN jsonb_build_object('adel_id', v_ex_adel, 'mov_id', v_ex_mov, 'idempotent_replay', true);
    END IF;
  END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  v_detalle := COALESCE(
    'Adelanto ' || v_emp.apellido || ' ' || v_emp.nombre
      || CASE WHEN p_detalle IS NOT NULL AND p_detalle <> '' THEN ' — ' || p_detalle ELSE '' END,
    'Adelanto'
  );

  IF v_emp.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_emp.local_id, -p_monto);
  END IF;

  INSERT INTO rrhh_adelantos (empleado_id, monto, fecha, local_id, cuenta, descontado, registrado_por, tenant_id)
  VALUES (p_empleado_id, p_monto, p_fecha, v_emp.local_id, p_cuenta, false,
    COALESCE(v_emp.apellido, ''), v_tenant)
  RETURNING id INTO v_adel_id;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, adelanto_id_ref, tenant_id, idempotency_key)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Adelanto', 'SUELDOS', -p_monto, v_detalle, v_emp.local_id, v_adel_id, v_tenant, p_idempotency_key);

  PERFORM _auditar('rrhh_adelantos', 'CREAR', jsonb_build_object(
    'adel_id', v_adel_id, 'emp_id', p_empleado_id, 'monto', p_monto,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('adel_id', v_adel_id, 'mov_id', v_mov_id);
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, adelanto_id_ref INTO v_ex_mov, v_ex_adel
      FROM movimientos WHERE idempotency_key = p_idempotency_key LIMIT 1;
    RETURN jsonb_build_object('adel_id', v_ex_adel, 'mov_id', v_ex_mov, 'idempotent_replay', true);
END;
$function$;
