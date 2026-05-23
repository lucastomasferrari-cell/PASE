-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: pagar_aguinaldo + pagar_vacaciones pasan text a columna integer
--
-- Bug detectado en test E2E 19: rrhh_pagos_especiales.pagado_por es INTEGER
-- pero las RPCs pasan `COALESCE(auth_usuario_id()::text, 'rpc')` → falla con
--   column "pagado_por" is of type integer but expression is of type text
--
-- Significa que TODOS los pagos de aguinaldo + vacaciones desde el cambio
-- de tipo de la columna están rotos en prod.
--
-- Fix: pasar auth_usuario_id() (INTEGER) directo sin cast a text.
-- ═══════════════════════════════════════════════════════════════════════════

-- pagar_aguinaldo: cambiar línea `COALESCE(auth_usuario_id()::text, 'rpc')`
-- a `auth_usuario_id()` (integer).
CREATE OR REPLACE FUNCTION pagar_aguinaldo(
  p_empleado_id uuid, p_lineas jsonb, p_monto_esperado numeric, p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_emp RECORD; v_linea jsonb; v_cuenta text; v_monto numeric;
  v_total_pagado numeric := 0; v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text; v_pago_id uuid; v_pendiente boolean; v_desc text;
  v_tenant uuid;
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

  v_pago_id := gen_random_uuid();
  -- FIX: pagado_por es INTEGER (no text). Pasamos auth_usuario_id() directo.
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, gasto_id, pagado_por, tenant_id)
  VALUES (v_pago_id, p_empleado_id, 'aguinaldo',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    NULL, auth_usuario_id(), v_tenant);

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Aguinaldo', 'SUELDOS', -v_monto, v_desc, v_emp.local_id, v_pago_id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET aguinaldo_acumulado = 0 WHERE id = p_empleado_id;
  END IF;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$$;

-- pagar_vacaciones: mismo bug
CREATE OR REPLACE FUNCTION pagar_vacaciones(
  p_empleado_id uuid, p_lineas jsonb, p_dias numeric, p_monto_esperado numeric, p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_emp RECORD; v_linea jsonb; v_cuenta text; v_monto numeric;
  v_total_pagado numeric := 0; v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text; v_pago_id uuid; v_pendiente boolean; v_desc text;
  v_tenant uuid;
BEGIN
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_dias IS NULL OR p_dias <= 0 THEN RAISE EXCEPTION 'DIAS_INVALIDOS'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Vacaciones ' || p_dias::text || ' días ' || v_emp.apellido || ' ' || v_emp.nombre;

  v_pago_id := gen_random_uuid();
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, dias, pendiente, gasto_id, pagado_por, tenant_id)
  VALUES (v_pago_id, p_empleado_id, 'vacaciones',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, p_dias, v_pendiente,
    NULL, auth_usuario_id(), v_tenant);

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Vacaciones', 'SUELDOS', -v_monto, v_desc, v_emp.local_id, v_pago_id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET vacaciones_dias_acumulados = GREATEST(0, vacaciones_dias_acumulados - p_dias)
      WHERE id = p_empleado_id;
  END IF;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$$;

NOTIFY pgrst, 'reload schema';
