-- 202606222000_liquidacion_final_local_por_linea.sql
-- Liquidación final: permitir elegir de QUÉ LOCAL sale la plata por cada forma
-- de pago (Lucas 22-jun). Antes usaba siempre el local PRINCIPAL del empleado
-- (v_emp.local_id) → para un cesionado, descontaba del local de origen aunque
-- lo pagaras desde otro. Igual que pagar_sueldo: cada línea de p_pagos puede
-- traer `local_id`; si no viene, cae al principal (compat).
CREATE OR REPLACE FUNCTION public.liquidacion_final_empleado(
  p_empleado_id uuid,
  p_fecha_egreso date,
  p_motivo text,
  p_total numeric,
  p_cuenta text DEFAULT NULL,
  p_pagos jsonb DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_existe int; v_mov_id text; v_pago_id uuid;
  v_desc text; v_tenant uuid;
  v_linea jsonb; v_cuenta text; v_monto numeric; v_suma numeric := 0;
  v_linea_local integer;   -- ★ NUEVO: local de cada línea
  v_mov_ids text[] := '{}';
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  SELECT COUNT(*) INTO v_existe FROM rrhh_pagos_especiales
   WHERE empleado_id = p_empleado_id AND tipo = 'liquidacion_final';
  IF v_existe > 0 THEN RAISE EXCEPTION 'LIQ_FINAL_YA_EXISTE'; END IF;

  IF p_pagos IS NULL OR jsonb_typeof(p_pagos) <> 'array' OR jsonb_array_length(p_pagos) = 0 THEN
    IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
    p_pagos := jsonb_build_array(jsonb_build_object('cuenta', p_cuenta, 'monto', p_total));
  END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_cuenta := v_linea->>'cuenta';
    v_monto := (v_linea->>'monto')::numeric;
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
    IF v_monto IS NULL OR v_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
    v_suma := v_suma + v_monto;
  END LOOP;
  IF abs(v_suma - p_total) > 1 THEN RAISE EXCEPTION 'PAGOS_NO_SUMAN_TOTAL'; END IF;

  v_desc := 'Liquidación final ' || v_emp.apellido || ' ' || v_emp.nombre;
  v_pago_id := gen_random_uuid();

  INSERT INTO rrhh_pagos_especiales (
    id, empleado_id, tipo, monto, gasto_id, pagado_por, tenant_id, anio, periodo
  )
  VALUES (
    v_pago_id, p_empleado_id, 'liquidacion_final', p_total, NULL,
    auth_usuario_id(), v_tenant,
    EXTRACT(year FROM p_fecha_egreso)::INTEGER, 'liq'
  );

  -- Un movimiento por forma de pago, con SU local (si la línea lo trae).
  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_cuenta := v_linea->>'cuenta';
    v_monto := (v_linea->>'monto')::numeric;
    -- ★ local de la línea; si no viene, el principal del empleado (compat).
    v_linea_local := COALESCE(NULLIF(v_linea->>'local_id', '')::integer, v_emp.local_id);
    PERFORM _validar_local_autorizado(v_linea_local);
    IF v_linea_local IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_linea_local, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
    VALUES (v_mov_id, p_fecha_egreso, v_cuenta, 'Liquidación Final', 'SUELDOS',
      -v_monto,
      v_desc || CASE WHEN v_emp.local_id IS NOT NULL AND v_linea_local IS NOT NULL
                       AND v_linea_local <> v_emp.local_id
                     THEN ' [caja de otro local]' ELSE '' END,
      v_linea_local, v_pago_id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  UPDATE rrhh_empleados
     SET activo = false, fecha_egreso = p_fecha_egreso, motivo_baja = p_motivo,
         vacaciones_dias_acumulados = 0, aguinaldo_acumulado = 0
   WHERE id = p_empleado_id;

  PERFORM _auditar('rrhh_empleados', 'LIQUIDACION_FINAL', jsonb_build_object(
    'emp_id', p_empleado_id, 'total', p_total, 'motivo', p_motivo,
    'mov_ids', to_jsonb(v_mov_ids), 'pago_id', v_pago_id, 'usuario_id', auth_usuario_id(),
    'formas_pago', jsonb_array_length(p_pagos)
  ), v_tenant);

  RETURN jsonb_build_object(
    'pago_id', v_pago_id,
    'mov_id', v_mov_ids[1],
    'mov_ids', to_jsonb(v_mov_ids),
    'emp_id', p_empleado_id
  );
END;
$function$;
