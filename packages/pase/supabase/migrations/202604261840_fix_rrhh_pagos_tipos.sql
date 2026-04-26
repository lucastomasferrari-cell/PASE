-- ═══════════════════════════════════════════════════════════════════════════
-- Fix de 2 bugs en RPCs de pagos RRHH.
--
-- BUG 1: pagar_sueldo falla con "CASE types text and integer cannot be
--        matched" porque CASE WHEN v_completa THEN auth_usuario_id() ELSE
--        pagado_por END mezcla integer (return de auth_usuario_id) con
--        text (tipo de la columna). Fix: cast ::text.
--
-- BUG 2: registrar_adelanto falla con 'column "id" is of type integer but
--        expression is of type uuid' porque v_adel_id := gen_random_uuid()
--        se inserta en rrhh_adelantos.id que es integer + sequence.
--        Fix de raíz: migrar id a uuid (alinea con rrhh_liquidaciones.id y
--        movimientos.adelanto_id_ref que ya son uuid).
--
-- Diagnóstico (Q7-Q9) validó:
--   - 0 FKs apuntando a rrhh_adelantos.id.
--   - 0 filas en rrhh_adelantos (sin migración de datos).
--   - movimientos.adelanto_id_ref ya es uuid (inconsistencia preexistente
--     que este fix también resuelve).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── BUG 2: rrhh_adelantos.id integer → uuid ────────────────────────────
ALTER TABLE rrhh_adelantos ALTER COLUMN id DROP DEFAULT;
ALTER TABLE rrhh_adelantos ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE rrhh_adelantos ALTER COLUMN id SET DEFAULT gen_random_uuid();
DROP SEQUENCE IF EXISTS rrhh_adelantos_id_seq;

-- ─── BUG 1: pagar_sueldo con cast ::text ────────────────────────────────
-- Cuerpo idéntico al actual (20260423_rpc_pagos_atomicos.sql) con el
-- único cambio en el UPDATE rrhh_liquidaciones SET pagado_por = ...
CREATE OR REPLACE FUNCTION public.pagar_sueldo(
  p_nov_id uuid,
  p_formas_pago jsonb,
  p_adelantos_ids uuid[],
  p_fecha date,
  p_mes integer,
  p_anio integer,
  p_crear_liq boolean DEFAULT false,
  p_calc jsonb DEFAULT NULL::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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
  -- FIX: cast auth_usuario_id()::text para que las dos ramas del CASE
  -- compartan tipo (la columna pagado_por es text).
  UPDATE rrhh_liquidaciones
  SET pagos_realizados = v_nuevos_pagos,
      estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
      pagado_at = CASE WHEN v_completa THEN now() ELSE pagado_at END,
      pagado_por = CASE WHEN v_completa THEN auth_usuario_id()::text ELSE pagado_por END
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
$function$;

-- ─── BUG 2 cont.: registrar_adelanto sin id explícito ───────────────────
-- Con id ya uuid y default gen_random_uuid(), dejamos que el default
-- genere el id y lo capturamos con RETURNING.
CREATE OR REPLACE FUNCTION public.registrar_adelanto(
  p_empleado_id uuid,
  p_monto numeric,
  p_cuenta text,
  p_fecha date,
  p_detalle text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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

  -- Insertar dejando que el default uuid genere el id; capturarlo vía RETURNING
  INSERT INTO rrhh_adelantos (empleado_id, monto, fecha, local_id, cuenta, descontado, registrado_por)
  VALUES (p_empleado_id, p_monto, p_fecha, v_emp.local_id, p_cuenta, false,
    COALESCE(v_emp.apellido, '')) -- registrado_por guarda texto por compat
  RETURNING id INTO v_adel_id;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, adelanto_id_ref)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Adelanto', 'SUELDOS', -p_monto, v_detalle, v_emp.local_id, v_adel_id);

  PERFORM _auditar('rrhh_adelantos', 'CREAR', jsonb_build_object(
    'adel_id', v_adel_id, 'emp_id', p_empleado_id, 'monto', p_monto,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('adel_id', v_adel_id, 'mov_id', v_mov_id);
END;
$function$;
