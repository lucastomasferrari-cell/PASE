-- ═══════════════════════════════════════════════════════════════════════════
-- Fix bug E2E test 25 / 26 — liquidacion_final_empleado no setea anio + periodo
--
-- Migration 202605270700 (audit F1 fix #5) agregó NOT NULL constraints en
-- anio + periodo de rrhh_pagos_especiales + actualizó pagar_aguinaldo y
-- pagar_vacaciones. Pero olvidó liquidacion_final_empleado, que sigue con
-- el INSERT viejo sin esos campos. Resultado: la RPC tira
-- "null value in column anio of relation rrhh_pagos_especiales violates
-- not-null constraint" cuando se llama desde el test de liquidación final.
--
-- Fix: agregar anio (year de p_fecha_egreso) + periodo = 'liq' al INSERT.
-- 'liq' es nuevo discriminador para liquidación final, en línea con
-- 'vac'/'jun'/'dic' que usan vacaciones y aguinaldo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION liquidacion_final_empleado(
  p_empleado_id uuid,
  p_fecha_egreso date,
  p_motivo text,
  p_total numeric,
  p_cuenta text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
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

  -- 29-may fix: agregar anio + periodo (eran NOT NULL desde migration 270700).
  INSERT INTO rrhh_pagos_especiales (
    id, empleado_id, tipo, monto, gasto_id, pagado_por, tenant_id,
    anio, periodo
  )
  VALUES (
    v_pago_id, p_empleado_id, 'liquidacion_final', p_total, NULL,
    auth_usuario_id(), v_tenant,
    EXTRACT(year FROM p_fecha_egreso)::INTEGER,
    'liq'  -- discriminador para liquidación final (alineado con 'vac', 'jun', 'dic')
  );

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

NOTIFY pgrst, 'reload schema';
