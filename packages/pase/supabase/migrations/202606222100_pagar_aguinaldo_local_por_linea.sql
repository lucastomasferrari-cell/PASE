-- 202606222100_pagar_aguinaldo_local_por_linea.sql
-- Aguinaldo: permitir elegir de QUÉ LOCAL sale la plata por cada forma de pago
-- (Lucas 22-jun: empleado de Belgrano cuyo aguinaldo se reparte entre 2 locales).
-- Antes el movimiento usaba siempre v_emp.local_id (el principal). Ahora cada
-- línea de p_lineas puede traer `local_id`; si no viene, cae al principal
-- (compat). El saldo lo sincroniza el trigger trg_sync_saldos_caja al insertar.
CREATE OR REPLACE FUNCTION public.pagar_aguinaldo(p_empleado_id uuid, p_lineas jsonb, p_monto_esperado numeric, p_fecha date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_linea jsonb; v_cuenta text; v_monto numeric;
  v_total_pagado numeric := 0; v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text; v_pago_id uuid; v_pendiente boolean; v_desc text;
  v_tenant uuid;
  v_anio integer;
  v_periodo text;
  v_linea_local integer;   -- ★ NUEVO: local de cada línea
BEGIN
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Aguinaldo ' || v_emp.apellido || ' ' || v_emp.nombre;
  v_anio := EXTRACT(year FROM p_fecha)::integer;
  v_periodo := CASE WHEN EXTRACT(month FROM p_fecha) <= 7 THEN 'jun' ELSE 'dic' END;

  v_pago_id := gen_random_uuid();
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, gasto_id, pagado_por, tenant_id, anio, periodo)
  VALUES (v_pago_id, p_empleado_id, 'aguinaldo',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    NULL, auth_usuario_id(), v_tenant, v_anio, v_periodo);

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
    -- ★ local de la línea; si no viene, el principal del empleado (compat).
    v_linea_local := COALESCE(NULLIF(v_linea->>'local_id', '')::integer, v_emp.local_id);
    PERFORM _validar_local_autorizado(v_linea_local);

    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Aguinaldo', 'SUELDOS', -v_monto,
      v_desc || CASE WHEN v_emp.local_id IS NOT NULL AND v_linea_local IS NOT NULL
                       AND v_linea_local <> v_emp.local_id
                     THEN ' [caja de otro local]' ELSE '' END,
      v_linea_local, v_pago_id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET aguinaldo_acumulado = 0 WHERE id = p_empleado_id;
  END IF;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$function$;
