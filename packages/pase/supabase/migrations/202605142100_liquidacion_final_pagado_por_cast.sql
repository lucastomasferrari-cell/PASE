-- ═══════════════════════════════════════════════════════════════════════════
-- BUGFIX: liquidacion_final_empleado castea pagado_por a text pero la
-- columna rrhh_pagos_especiales.pagado_por es INTEGER.
--
-- Fecha:    2026-05-14
-- Detectado por: test mutante (auditoría 2026-05-14, segundo bug encontrado
-- al re-correr el test después de fixear el tipo de id).
--
-- Causa: la RPC original (202604281206:609) hace:
--   COALESCE(auth_usuario_id()::text, 'rpc')
-- Pero rrhh_pagos_especiales.pagado_por es INTEGER. El INSERT siempre
-- fallaba con "column 'pagado_por' is of type integer but expression is
-- of type text".
--
-- Fix: pasar auth_usuario_id() directo (integer) y dejar que NULL caiga
-- en la columna si no hay user autenticado (la columna acepta NULL).
-- Sacrificamos el fallback 'rpc' literal — preferible NULL antes que
-- romper el INSERT.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION liquidacion_final_empleado(
  p_empleado_id uuid, p_fecha_egreso date, p_motivo text,
  p_total numeric, p_cuenta text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_emp RECORD; v_existe int; v_mov_id text; v_pago_id uuid;
  v_desc text; v_tenant uuid;
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  SELECT COUNT(*) INTO v_existe FROM rrhh_pagos_especiales
   WHERE empleado_id = p_empleado_id AND tipo = 'liquidacion_final';
  IF v_existe > 0 THEN RAISE EXCEPTION 'LIQ_FINAL_YA_EXISTE'; END IF;

  v_desc := 'Liquidación final ' || v_emp.apellido || ' ' || v_emp.nombre;

  v_pago_id := gen_random_uuid();
  -- ★ FIX 2026-05-14: pagado_por es INTEGER, no TEXT. Sacar el ::text.
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, gasto_id, pagado_por, tenant_id)
  VALUES (v_pago_id, p_empleado_id, 'liquidacion_final', p_total, NULL,
    auth_usuario_id(), v_tenant);

  IF v_emp.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_emp.local_id, -p_total);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
  VALUES (v_mov_id, p_fecha_egreso, p_cuenta, 'Liquidación Final', 'SUELDOS',
    -p_total, v_desc, v_emp.local_id, v_pago_id, v_tenant);

  UPDATE rrhh_empleados
     SET activo = false, fecha_egreso = p_fecha_egreso, motivo_baja = p_motivo,
         vacaciones_dias_acumulados = 0, aguinaldo_acumulado = 0
   WHERE id = p_empleado_id;

  PERFORM _auditar('rrhh_empleados', 'LIQUIDACION_FINAL', jsonb_build_object(
    'emp_id', p_empleado_id, 'total', p_total, 'motivo', p_motivo,
    'mov_id', v_mov_id, 'pago_id', v_pago_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_id', v_mov_id, 'emp_id', p_empleado_id);
END;
$$;
