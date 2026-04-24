-- ═══════════════════════════════════════════════════════════════════════════
-- Pagos atómicos: RPCs que agrupan las inserciones/updates de cada flujo de
-- pago en una sola transacción. Si algo falla a mitad → rollback automático.
-- Reemplaza los múltiples inserts/updates sueltos que hacía el frontend.
--
-- Convenciones:
--  - Errores con RAISE EXCEPTION 'CODIGO_UPPER_SNAKE'. El cliente traduce
--    vía src/lib/errors.ts::translateRpcError.
--  - SECURITY INVOKER: respeta RLS del usuario llamador. Usa los helpers
--    auth_es_dueno_o_admin() / auth_locales_visibles() / auth_usuario_id()
--    del commit cbb89b3.
--  - Las RPCs que actualizan saldos_caja usan _actualizar_saldo_caja que
--    hace INSERT ... ON CONFLICT DO UPDATE para evitar fallar cuando la
--    fila (cuenta, local_id) aún no existe.
--  - Si el saldo queda < 0 después del update, se loguea un WARN en
--    auditoria pero NO se bloquea (p_permitir_negativo default true).
--
-- Nota: saldos_caja.MercadoPago es pisado por el cron mp-process con el
-- saldo autoritativo de MP. El delta de las RPCs sobre esa cuenta es
-- efímero hasta la próxima sync. Los otros saldos (Caja Chica/Mayor/
-- Efectivo/Banco) son persistentes.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Columnas de referencia en movimientos para anulación con vínculo duro.
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS liquidacion_id uuid;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS gasto_id_ref text;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS remito_id_ref text;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS adelanto_id_ref uuid;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS pago_especial_id_ref uuid;

-- 2) Helpers internos --------------------------------------------------------

-- Update de saldos_caja idempotente: si no hay fila, la crea con saldo = delta.
-- Devuelve el saldo final. Loguea WARN si queda negativo.
CREATE OR REPLACE FUNCTION _actualizar_saldo_caja(
  p_cuenta text,
  p_local_id int,
  p_delta numeric,
  p_permitir_negativo boolean DEFAULT true
) RETURNS numeric
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_saldo_final numeric;
BEGIN
  INSERT INTO saldos_caja (cuenta, local_id, saldo)
  VALUES (p_cuenta, p_local_id, p_delta)
  ON CONFLICT (cuenta, local_id) DO UPDATE
  SET saldo = COALESCE(saldos_caja.saldo, 0) + p_delta
  RETURNING saldo INTO v_saldo_final;

  IF v_saldo_final < 0 THEN
    IF NOT p_permitir_negativo THEN
      RAISE EXCEPTION 'SALDO_INSUFICIENTE';
    END IF;
    BEGIN
      INSERT INTO auditoria (tabla, accion, detalle, fecha)
      VALUES ('saldos_caja', 'WARN_SALDO_NEGATIVO',
        jsonb_build_object(
          'cuenta', p_cuenta,
          'local_id', p_local_id,
          'saldo_final', v_saldo_final,
          'delta', p_delta,
          'usuario_id', auth_usuario_id()
        )::text,
        now());
    EXCEPTION WHEN OTHERS THEN NULL; -- si no existe tabla auditoria, no bloquear
    END;
  END IF;

  RETURN v_saldo_final;
END;
$$;

-- Valida que el usuario puede operar sobre el local. Silencioso si es admin
-- o si el local_id es NULL (operaciones globales).
CREATE OR REPLACE FUNCTION _validar_local_autorizado(p_local_id int)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_local_id IS NULL THEN RETURN; END IF;
  IF auth_es_dueno_o_admin() THEN RETURN; END IF;
  IF NOT (p_local_id = ANY(COALESCE(auth_locales_visibles(), ARRAY[]::int[]))) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;
END;
$$;

-- Generador de id text estilo genId("MOV") del frontend.
CREATE OR REPLACE FUNCTION _gen_id(p_prefix text)
RETURNS text
LANGUAGE sql VOLATILE
AS $$
  SELECT p_prefix || '-' || extract(epoch from clock_timestamp())::bigint::text
    || '-' || substr(md5(random()::text), 1, 4);
$$;

-- Inserta auditoria sin fallar si la tabla no existe.
CREATE OR REPLACE FUNCTION _auditar(p_tabla text, p_accion text, p_detalle jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    INSERT INTO auditoria (tabla, accion, detalle, fecha)
    VALUES (p_tabla, p_accion, p_detalle::text, now());
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;

-- 3) RPCs de pago ────────────────────────────────────────────────────────────

-- pagar_factura: UPDATE facturas (estado + array pagos) + UPDATE proveedores
-- + UPDATE saldos_caja + INSERT movimientos + auditoria. Todo en una tx.
-- Nota: si p_cuenta='MercadoPago', el delta sobre saldos_caja es efímero
-- hasta la próxima sync de mp-process.
CREATE OR REPLACE FUNCTION pagar_factura(
  p_factura_id text,
  p_monto numeric,
  p_cuenta text,
  p_fecha date,
  p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_fac RECORD;
  v_nuevos_pagos jsonb;
  v_total_pagado numeric;
  v_nuevo_estado text;
  v_mov_id text;
  v_detalle text;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);

  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('cuenta', p_cuenta, 'monto', p_monto, 'fecha', p_fecha)
  );
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;

  v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos
  WHERE id = p_factura_id;

  IF v_fac.prov_id IS NOT NULL THEN
    UPDATE proveedores
    SET saldo = GREATEST(0, COALESCE(saldo, 0) - p_monto)
    WHERE id = v_fac.prov_id;
  END IF;

  IF v_fac.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_fac.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  v_detalle := COALESCE(p_detalle, 'Pago Fact ' || COALESCE(v_fac.nro, v_fac.id));
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, fact_id, local_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_fac.cat,
    -p_monto, v_detalle, p_factura_id, v_fac.local_id);

  PERFORM _auditar('facturas', 'PAGO', jsonb_build_object(
    'factura_id', p_factura_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado,
    'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object(
    'mov_id', v_mov_id,
    'nuevo_estado', v_nuevo_estado,
    'total_pagado', v_total_pagado
  );
END;
$$;

-- pagar_remito
CREATE OR REPLACE FUNCTION pagar_remito(
  p_remito_id text,
  p_monto numeric,
  p_cuenta text,
  p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_r RECORD;
  v_prov RECORD;
  v_mov_id text;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_ANULADO'; END IF;
  IF v_r.estado = 'pagado' THEN RAISE EXCEPTION 'REMITO_YA_PAGADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);

  UPDATE remitos SET estado = 'pagado' WHERE id = p_remito_id;

  SELECT * INTO v_prov FROM proveedores WHERE id = v_r.prov_id;
  IF v_prov.id IS NOT NULL THEN
    UPDATE proveedores SET saldo = GREATEST(0, COALESCE(saldo, 0) - p_monto) WHERE id = v_r.prov_id;
  END IF;

  IF v_r.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_r.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, remito_id_ref)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_r.cat, -p_monto,
    'Pago remito ' || COALESCE(v_r.nro, v_r.id) || COALESCE(' - ' || v_prov.nombre, ''),
    v_r.local_id, p_remito_id);

  PERFORM _auditar('remitos', 'PAGO', jsonb_build_object(
    'remito_id', p_remito_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', 'pagado');
END;
$$;

-- anular_factura
CREATE OR REPLACE FUNCTION anular_factura(
  p_factura_id text,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_fac RECORD;
BEGIN
  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_YA_ANULADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);

  UPDATE facturas SET estado = 'anulada' WHERE id = p_factura_id;

  IF v_fac.prov_id IS NOT NULL AND v_fac.estado <> 'pagada' THEN
    UPDATE proveedores
    SET saldo = GREATEST(0, COALESCE(saldo, 0) - COALESCE(v_fac.total, 0))
    WHERE id = v_fac.prov_id;
  END IF;

  PERFORM _auditar('facturas', 'ANULACION', jsonb_build_object(
    'factura_id', p_factura_id, 'motivo', p_motivo,
    'estado_previo', v_fac.estado, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada');
END;
$$;

-- anular_remito
CREATE OR REPLACE FUNCTION anular_remito(
  p_remito_id text,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_r RECORD;
BEGIN
  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);

  UPDATE remitos SET estado = 'anulado' WHERE id = p_remito_id;

  IF v_r.estado = 'sin_factura' AND v_r.prov_id IS NOT NULL THEN
    UPDATE proveedores
    SET saldo = GREATEST(0, COALESCE(saldo, 0) - COALESCE(v_r.monto, 0))
    WHERE id = v_r.prov_id;
  END IF;

  PERFORM _auditar('remitos', 'ANULACION', jsonb_build_object(
    'remito_id', p_remito_id, 'motivo', p_motivo,
    'estado_previo', v_r.estado, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('remito_id', p_remito_id, 'estado', 'anulado');
END;
$$;

-- pagar_sueldo: el caso más complejo. Loop por formas_pago, update
-- liquidación, marca adelantos descontados, ajusta aguinaldo_acumulado.
-- Si p_crear_liq es true y no hay liq para el nov, la crea con p_calc.
-- Nota: al usar MercadoPago, el delta sobre saldos_caja es efímero hasta
-- la próxima sync de mp-process.
CREATE OR REPLACE FUNCTION pagar_sueldo(
  p_nov_id uuid,
  p_formas_pago jsonb,        -- [{cuenta, monto}]
  p_adelantos_ids uuid[],     -- adelantos pendientes a marcar descontados
  p_fecha date,
  p_mes int,
  p_anio int,
  p_crear_liq boolean DEFAULT false,
  p_calc jsonb DEFAULT NULL    -- si hay que crear la liq: todos los fields calc
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
  v_liq RECORD;
  v_fp jsonb;
  v_monto numeric;
  v_cuenta text;
  v_asignado_cash numeric := 0;
  v_total_adelantos numeric := 0;
  v_total_a_pagar numeric;
  v_ya_pagado numeric;
  v_pendiente numeric;
  v_asignado_total numeric;
  v_completa boolean;
  v_nuevos_pagos numeric;
  v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text;
  v_desc text;
  v_meses_nombre text[] := ARRAY['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
BEGIN
  IF p_nov_id IS NULL THEN RAISE EXCEPTION 'NOVEDAD_INVALIDA'; END IF;

  SELECT e.* INTO v_emp
  FROM rrhh_empleados e
  JOIN rrhh_novedades n ON n.empleado_id = e.id
  WHERE n.id = p_nov_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);

  -- Obtener o crear la liquidación
  SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
  IF v_liq IS NULL THEN
    IF NOT p_crear_liq OR p_calc IS NULL THEN
      RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA';
    END IF;
    INSERT INTO rrhh_liquidaciones (
      novedad_id, sueldo_base, descuento_ausencias, total_horas_extras,
      total_dobles, total_feriados, total_vacaciones, subtotal1,
      monto_presentismo, subtotal2, adelantos, pagos_realizados,
      total_a_pagar, efectivo, transferencia, estado, calculado_at
    )
    VALUES (
      p_nov_id,
      (p_calc->>'sueldo_base')::numeric,
      (p_calc->>'descuento_ausencias')::numeric,
      (p_calc->>'total_horas_extras')::numeric,
      (p_calc->>'total_dobles')::numeric,
      (p_calc->>'total_feriados')::numeric,
      COALESCE((p_calc->>'total_vacaciones')::numeric, 0),
      (p_calc->>'subtotal1')::numeric,
      (p_calc->>'monto_presentismo')::numeric,
      (p_calc->>'subtotal2')::numeric,
      COALESCE((p_calc->>'adelantos')::numeric, 0),
      0, -- pagos_realizados empieza en 0
      (p_calc->>'total_a_pagar')::numeric,
      COALESCE((p_calc->>'efectivo')::numeric, 0),
      COALESCE((p_calc->>'transferencia')::numeric, 0),
      'pendiente',
      now()
    )
    RETURNING * INTO v_liq;
  END IF;

  IF v_liq.anulado IS TRUE THEN RAISE EXCEPTION 'LIQUIDACION_ANULADA'; END IF;
  IF v_liq.estado = 'pagado' THEN RAISE EXCEPTION 'LIQUIDACION_YA_PAGADA'; END IF;

  v_total_a_pagar := ROUND(COALESCE(v_liq.total_a_pagar, 0));
  v_ya_pagado := ROUND(COALESCE(v_liq.pagos_realizados, 0));
  v_pendiente := GREATEST(0, v_total_a_pagar - v_ya_pagado);

  -- Calcular total adelantos
  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(monto), 0) INTO v_total_adelantos
    FROM rrhh_adelantos WHERE id = ANY(p_adelantos_ids) AND descontado = false;
  END IF;
  v_total_adelantos := ROUND(v_total_adelantos);

  -- Calcular total formas pago cash
  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb))
  LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_asignado_cash := v_asignado_cash + v_monto;
  END LOOP;

  v_asignado_total := v_asignado_cash + v_total_adelantos;
  IF v_asignado_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF v_asignado_total > v_pendiente THEN RAISE EXCEPTION 'MONTO_EXCEDE_PENDIENTE'; END IF;

  v_completa := v_asignado_total >= v_pendiente;
  v_nuevos_pagos := v_ya_pagado + v_asignado_total;
  v_desc := CASE
    WHEN v_completa AND v_ya_pagado = 0 THEN 'Sueldo'
    WHEN v_completa THEN 'Sueldo (saldo final)'
    ELSE 'Sueldo (parcial)'
  END || ' ' || v_emp.apellido || ' ' || v_emp.nombre
    || ' - ' || v_meses_nombre[p_mes+1] || ' ' || p_anio;

  -- Insertar movimientos + actualizar saldos
  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb))
  LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_fp->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, liquidacion_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Sueldo', 'SUELDOS',
      -v_monto, v_desc, v_emp.local_id, v_liq.id);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  -- Update liquidación
  UPDATE rrhh_liquidaciones
  SET pagos_realizados = v_nuevos_pagos,
      estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
      pagado_at = CASE WHEN v_completa THEN now() ELSE pagado_at END,
      pagado_por = CASE WHEN v_completa THEN auth_usuario_id() ELSE pagado_por END
  WHERE id = v_liq.id;

  -- Marcar adelantos descontados
  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    UPDATE rrhh_adelantos SET descontado = true
    WHERE id = ANY(p_adelantos_ids);
  END IF;

  -- Si completa pago, ajustar aguinaldo acumulado
  IF v_completa THEN
    UPDATE rrhh_empleados
    SET aguinaldo_acumulado = COALESCE(aguinaldo_acumulado, 0) + v_total_a_pagar / 12.0
    WHERE id = v_emp.id;
  END IF;

  PERFORM _auditar('rrhh_liquidaciones', 'PAGO', jsonb_build_object(
    'liq_id', v_liq.id, 'nov_id', p_nov_id, 'emp_id', v_emp.id,
    'monto_asignado', v_asignado_total, 'completa', v_completa,
    'mov_ids', to_jsonb(v_mov_ids), 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object(
    'liq_id', v_liq.id,
    'mov_ids', to_jsonb(v_mov_ids),
    'completa', v_completa,
    'pagos_realizados', v_nuevos_pagos
  );
END;
$$;

-- registrar_adelanto
CREATE OR REPLACE FUNCTION registrar_adelanto(
  p_empleado_id uuid,
  p_monto numeric,
  p_cuenta text,
  p_fecha date,
  p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
  v_mov_id text;
  v_adel_id uuid;
  v_detalle text;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);

  v_detalle := COALESCE(
    'Adelanto ' || v_emp.apellido || ' ' || v_emp.nombre
      || CASE WHEN p_detalle IS NOT NULL AND p_detalle <> '' THEN ' — ' || p_detalle ELSE '' END,
    'Adelanto'
  );

  IF v_emp.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_emp.local_id, -p_monto);
  END IF;

  v_adel_id := gen_random_uuid();
  INSERT INTO rrhh_adelantos (id, empleado_id, monto, fecha, local_id, cuenta, descontado, registrado_por)
  VALUES (v_adel_id, p_empleado_id, p_monto, p_fecha, v_emp.local_id, p_cuenta, false,
    COALESCE(v_emp.apellido, '')); -- registrado_por guarda texto por compat

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, adelanto_id_ref)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Adelanto', 'SUELDOS', -p_monto, v_detalle, v_emp.local_id, v_adel_id);

  PERFORM _auditar('rrhh_adelantos', 'CREAR', jsonb_build_object(
    'adel_id', v_adel_id, 'emp_id', p_empleado_id, 'monto', p_monto,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('adel_id', v_adel_id, 'mov_id', v_mov_id);
END;
$$;

-- pagar_vacaciones: loop por lineas + update empleado si completa.
CREATE OR REPLACE FUNCTION pagar_vacaciones(
  p_empleado_id uuid,
  p_lineas jsonb,           -- [{cuenta, monto}]
  p_dias numeric,
  p_monto_esperado numeric,
  p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
  v_linea jsonb;
  v_cuenta text;
  v_monto numeric;
  v_total_pagado numeric := 0;
  v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text;
  v_pago_id uuid;
  v_pendiente boolean;
  v_desc text;
BEGIN
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  PERFORM _validar_local_autorizado(v_emp.local_id);

  IF p_dias IS NULL OR p_dias <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Vacaciones ' || v_emp.apellido || ' ' || v_emp.nombre;

  v_pago_id := gen_random_uuid();
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, dias, gasto_id, pagado_por)
  VALUES (v_pago_id, p_empleado_id, 'vacaciones',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    p_dias, NULL, COALESCE(auth_usuario_id()::text, 'rpc'));

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Vacaciones', 'SUELDOS', -v_monto, v_desc, v_emp.local_id, v_pago_id);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET vacaciones_dias_acumulados = 0 WHERE id = p_empleado_id;
  END IF;

  PERFORM _auditar('rrhh_pagos_especiales', 'VACACIONES', jsonb_build_object(
    'pago_id', v_pago_id, 'emp_id', p_empleado_id, 'total_pagado', v_total_pagado,
    'mov_ids', to_jsonb(v_mov_ids), 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$$;

-- pagar_aguinaldo
CREATE OR REPLACE FUNCTION pagar_aguinaldo(
  p_empleado_id uuid,
  p_lineas jsonb,
  p_monto_esperado numeric,
  p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
  v_linea jsonb;
  v_cuenta text;
  v_monto numeric;
  v_total_pagado numeric := 0;
  v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text;
  v_pago_id uuid;
  v_pendiente boolean;
  v_desc text;
BEGIN
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  PERFORM _validar_local_autorizado(v_emp.local_id);

  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Aguinaldo ' || v_emp.apellido || ' ' || v_emp.nombre;

  v_pago_id := gen_random_uuid();
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, gasto_id, pagado_por)
  VALUES (v_pago_id, p_empleado_id, 'aguinaldo',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    NULL, COALESCE(auth_usuario_id()::text, 'rpc'));

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Aguinaldo', 'SUELDOS', -v_monto, v_desc, v_emp.local_id, v_pago_id);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET aguinaldo_acumulado = 0 WHERE id = p_empleado_id;
  END IF;

  PERFORM _auditar('rrhh_pagos_especiales', 'AGUINALDO', jsonb_build_object(
    'pago_id', v_pago_id, 'emp_id', p_empleado_id, 'total_pagado', v_total_pagado,
    'mov_ids', to_jsonb(v_mov_ids), 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$$;

-- liquidacion_final_empleado: check único + insert pago + mov + update emp.
CREATE OR REPLACE FUNCTION liquidacion_final_empleado(
  p_empleado_id uuid,
  p_fecha_egreso date,
  p_motivo text,
  p_total numeric,
  p_cuenta text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
  v_existe int;
  v_mov_id text;
  v_pago_id uuid;
  v_desc text;
BEGIN
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);

  SELECT COUNT(*) INTO v_existe FROM rrhh_pagos_especiales
  WHERE empleado_id = p_empleado_id AND tipo = 'liquidacion_final';
  IF v_existe > 0 THEN RAISE EXCEPTION 'LIQ_FINAL_YA_EXISTE'; END IF;

  v_desc := 'Liquidación final ' || v_emp.apellido || ' ' || v_emp.nombre;

  v_pago_id := gen_random_uuid();
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, gasto_id, pagado_por)
  VALUES (v_pago_id, p_empleado_id, 'liquidacion_final', p_total, NULL,
    COALESCE(auth_usuario_id()::text, 'rpc'));

  IF v_emp.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_emp.local_id, -p_total);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref)
  VALUES (v_mov_id, p_fecha_egreso, p_cuenta, 'Liquidación Final', 'SUELDOS',
    -p_total, v_desc, v_emp.local_id, v_pago_id);

  UPDATE rrhh_empleados
  SET activo = false,
      fecha_egreso = p_fecha_egreso,
      motivo_baja = p_motivo,
      vacaciones_dias_acumulados = 0,
      aguinaldo_acumulado = 0
  WHERE id = p_empleado_id;

  PERFORM _auditar('rrhh_empleados', 'LIQUIDACION_FINAL', jsonb_build_object(
    'emp_id', p_empleado_id, 'total', p_total, 'motivo', p_motivo,
    'mov_id', v_mov_id, 'pago_id', v_pago_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_id', v_mov_id, 'emp_id', p_empleado_id);
END;
$$;

-- crear_movimiento_caja: INSERT + update saldo. El importe es signed.
CREATE OR REPLACE FUNCTION crear_movimiento_caja(
  p_fecha date,
  p_cuenta text,
  p_tipo text,
  p_cat text,
  p_importe numeric,           -- signed: positivo ingreso, negativo egreso
  p_detalle text,
  p_local_id int
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_mov_id text;
BEGIN
  IF p_importe IS NULL OR p_importe = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);

  PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, p_importe);

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, p_tipo, p_cat, p_importe, p_detalle, p_local_id);

  PERFORM _auditar('movimientos', 'CREAR', jsonb_build_object(
    'mov_id', v_mov_id, 'importe', p_importe, 'cuenta', p_cuenta,
    'local_id', p_local_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('mov_id', v_mov_id);
END;
$$;

-- anular_movimiento: propagación por refs explícitas; fallback al match viejo
-- (detalle+fecha+cuenta+local_id en gastos) para retrocompat.
CREATE OR REPLACE FUNCTION anular_movimiento(
  p_mov_id text,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_mov RECORD;
  v_gasto_id text;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- Revertir saldo
  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  -- Propagar anulación a rrhh_liquidaciones
  IF v_mov.liquidacion_id IS NOT NULL THEN
    UPDATE rrhh_liquidaciones SET anulado = true WHERE id = v_mov.liquidacion_id;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
    -- Fallback: match viejo por (detalle+fecha+cuenta+local_id) contra gastos
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
$$;

-- crear_gasto: INSERT gasto + update saldo + INSERT movimiento. Incluye
-- soporte para plantilla (p_plantilla_id opcional).
CREATE OR REPLACE FUNCTION crear_gasto(
  p_fecha date,
  p_local_id int,
  p_categoria text,
  p_tipo text,
  p_monto numeric,
  p_detalle text,
  p_cuenta text,
  p_plantilla_id int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_gasto_id text;
  v_mov_id text;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR p_categoria = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);

  v_gasto_id := _gen_id('GASTO');
  INSERT INTO gastos (id, fecha, local_id, categoria, tipo, monto, detalle, cuenta, plantilla_id)
  VALUES (v_gasto_id, p_fecha, p_local_id, p_categoria, p_tipo, p_monto, p_detalle, p_cuenta, p_plantilla_id);

  IF p_local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, gasto_id_ref)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Gasto ' || COALESCE(p_tipo, ''),
    p_categoria, -p_monto, COALESCE(p_detalle, p_categoria), p_local_id, v_gasto_id);

  PERFORM _auditar('gastos', 'CREAR', jsonb_build_object(
    'gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'monto', p_monto,
    'categoria', p_categoria, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('gasto_id', v_gasto_id, 'mov_id', v_mov_id);
END;
$$;

-- transferencia_cuentas: dos movimientos signed opuestos + update saldos.
-- Utility sin UI actual; preparada para uso futuro.
CREATE OR REPLACE FUNCTION transferencia_cuentas(
  p_local_id int,
  p_cuenta_origen text,
  p_cuenta_destino text,
  p_monto numeric,
  p_fecha date,
  p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_mov_out text;
  v_mov_in text;
  v_detalle text;
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
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id)
  VALUES (v_mov_out, p_fecha, p_cuenta_origen, 'Transferencia Salida', NULL,
    -p_monto, v_detalle, p_local_id);

  v_mov_in := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id)
  VALUES (v_mov_in, p_fecha, p_cuenta_destino, 'Transferencia Entrada', NULL,
    p_monto, v_detalle, p_local_id);

  PERFORM _auditar('movimientos', 'TRANSFERENCIA', jsonb_build_object(
    'mov_out', v_mov_out, 'mov_in', v_mov_in, 'monto', p_monto,
    'origen', p_cuenta_origen, 'destino', p_cuenta_destino,
    'local_id', p_local_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('mov_out', v_mov_out, 'mov_in', v_mov_in);
END;
$$;

-- 4) Permisos de ejecución
GRANT EXECUTE ON FUNCTION
  pagar_factura, pagar_remito, anular_factura, anular_remito,
  pagar_sueldo, registrar_adelanto, pagar_vacaciones, pagar_aguinaldo,
  liquidacion_final_empleado, crear_movimiento_caja, anular_movimiento,
  crear_gasto, transferencia_cuentas
TO authenticated;
