-- 202606042700_fix_pagar_sueldo_for_update_adelantos.sql
-- BUG (Lucas 04-jun): pagar un sueldo de un empleado CON adelantos tildados
-- fallaba con "FOR UPDATE is not allowed with aggregate functions". pagar_sueldo
-- hacía SELECT SUM(monto) ... FOR UPDATE (Postgres no permite FOR UPDATE con un
-- agregado). Fix: lockear las filas con un PERFORM ... FOR UPDATE aparte y sumar
-- sin FOR UPDATE. Tomado de la fuente viva, solo cambia ese bloque.

CREATE OR REPLACE FUNCTION public.pagar_sueldo(p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[], p_fecha date, p_mes integer, p_anio integer, p_crear_liq boolean DEFAULT false, p_calc jsonb DEFAULT NULL::jsonb, p_idempotency_key text DEFAULT NULL::text, p_liq_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_liq RECORD; v_fp jsonb; v_monto numeric; v_cuenta text;
  v_linea_local_id integer;
  v_asignado_cash numeric := 0; v_total_adelantos numeric := 0;
  v_total_a_pagar numeric; v_ya_pagado numeric; v_pendiente numeric;
  v_asignado_total numeric; v_completa boolean; v_nuevos_pagos numeric;
  v_sobrepago numeric := 0;
  v_mov_ids text[] := ARRAY[]::text[]; v_mov_id text; v_desc text;
  v_meses_nombre text[] := ARRAY['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  v_tenant uuid;
  v_cached jsonb;
  v_result jsonb;
  v_count_liqs integer;
  v_cuota_label text;
  v_locales_pagaron integer[];
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- AUDIT FIX #8: filtro por tenant en idempotency lookup.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'pagar_sueldo' AND key = p_idempotency_key AND tenant_id = v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay', true); END IF;
  END IF;

  IF p_nov_id IS NULL THEN RAISE EXCEPTION 'NOVEDAD_INVALIDA'; END IF;

  SELECT e.* INTO v_emp FROM rrhh_empleados e
    JOIN rrhh_novedades n ON n.empleado_id = e.id
   WHERE n.id = p_nov_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);

  -- AUDIT FIX #9: FOR UPDATE en rrhh_liquidaciones para evitar race condition
  -- de doble pago concurrente.
  IF p_liq_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = p_liq_id FOR UPDATE;
    IF v_liq IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
    IF v_liq.novedad_id IS DISTINCT FROM p_nov_id THEN
      RAISE EXCEPTION 'LIQUIDACION_NOVEDAD_MISMATCH';
    END IF;
  ELSE
    SELECT COUNT(*) INTO v_count_liqs FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
    IF v_count_liqs > 1 THEN
      RAISE EXCEPTION 'MULTIPLES_CUOTAS_REQUIERE_LIQ_ID';
    END IF;
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id FOR UPDATE;
    IF v_liq IS NULL THEN
      IF NOT p_crear_liq OR p_calc IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
      INSERT INTO rrhh_liquidaciones (
        novedad_id, sueldo_base, descuento_ausencias, total_horas_extras,
        total_dobles, total_feriados, total_vacaciones, subtotal1,
        monto_presentismo, subtotal2, adelantos, pagos_realizados,
        total_a_pagar, efectivo, transferencia, estado, calculado_at, tenant_id,
        cuota_num, cuotas_total
      ) VALUES (
        p_nov_id,
        (p_calc->>'sueldo_base')::numeric, (p_calc->>'descuento_ausencias')::numeric,
        (p_calc->>'total_horas_extras')::numeric, (p_calc->>'total_dobles')::numeric,
        (p_calc->>'total_feriados')::numeric, COALESCE((p_calc->>'total_vacaciones')::numeric, 0),
        (p_calc->>'subtotal1')::numeric, (p_calc->>'monto_presentismo')::numeric,
        (p_calc->>'subtotal2')::numeric, COALESCE((p_calc->>'adelantos')::numeric, 0),
        0, (p_calc->>'total_a_pagar')::numeric,
        COALESCE((p_calc->>'efectivo')::numeric, 0),
        COALESCE((p_calc->>'transferencia')::numeric, 0),
        'pendiente', now(), v_tenant,
        1, 1
      ) RETURNING * INTO v_liq;
    END IF;
  END IF;

  IF v_liq.anulado IS TRUE THEN RAISE EXCEPTION 'LIQUIDACION_ANULADA'; END IF;
  IF v_liq.estado = 'pagado' THEN RAISE EXCEPTION 'LIQUIDACION_YA_PAGADA'; END IF;

  v_total_a_pagar := ROUND(COALESCE(v_liq.total_a_pagar, 0));
  v_ya_pagado := ROUND(COALESCE(v_liq.pagos_realizados, 0));
  v_pendiente := GREATEST(0, v_total_a_pagar - v_ya_pagado);

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    -- Lock de las filas SIN agregado: FOR UPDATE no se permite junto a SUM
    -- (error "FOR UPDATE is not allowed with aggregate functions" al pagar con
    -- adelantos). Lockeamos aparte y sumamos sin FOR UPDATE. Fix Lucas 04-jun.
    PERFORM 1 FROM rrhh_adelantos
     WHERE id = ANY(p_adelantos_ids) AND descontado = false FOR UPDATE;
    SELECT COALESCE(SUM(monto), 0) INTO v_total_adelantos FROM rrhh_adelantos
     WHERE id = ANY(p_adelantos_ids) AND descontado = false;
  END IF;
  v_total_adelantos := ROUND(v_total_adelantos);

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_asignado_cash := v_asignado_cash + v_monto;
  END LOOP;

  v_asignado_total := v_asignado_cash + v_total_adelantos;
  IF v_asignado_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  v_completa := v_asignado_total >= v_pendiente;
  v_sobrepago := GREATEST(0, v_asignado_total - v_pendiente);
  -- ★ CAMBIO 04-jun: SIN cap. pagos_realizados guarda el monto real pagado
  -- (incluye el sobrepago de redondeo). Antes: LEAST(v_total_a_pagar, ...).
  -- Queda alineado con el trigger _resync_liquidacion_pagos. El aguinaldo
  -- (más abajo) se sigue calculando sobre v_total_a_pagar, NO sobre esto.
  v_nuevos_pagos := v_ya_pagado + v_asignado_total;

  IF COALESCE(v_liq.cuotas_total, 1) > 1 THEN
    v_cuota_label := ' [Cuota ' || v_liq.cuota_num || '/' || v_liq.cuotas_total || ']';
  ELSE
    v_cuota_label := '';
  END IF;

  v_desc := CASE
    WHEN v_completa AND v_ya_pagado = 0 THEN 'Sueldo'
    WHEN v_completa THEN 'Sueldo (saldo final)'
    ELSE 'Sueldo (parcial)'
  END || ' ' || v_emp.apellido || ' ' || v_emp.nombre
    || ' - ' || v_meses_nombre[p_mes+1] || ' ' || p_anio
    || v_cuota_label
    || CASE WHEN v_sobrepago > 0
            THEN ' (sobrepago $' || v_sobrepago::text || ')'
            ELSE '' END;

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_fp->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    v_linea_local_id := COALESCE(
      NULLIF(v_fp->>'local_id', '')::integer,
      v_emp.local_id
    );

    PERFORM _validar_local_autorizado(v_linea_local_id);

    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, liquidacion_id, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Sueldo', 'SUELDOS',
      -v_monto,
      v_desc || CASE
        WHEN v_emp.local_id IS NOT NULL AND v_linea_local_id IS NOT NULL
             AND v_linea_local_id <> v_emp.local_id
        THEN ' [pago repartido]'
        ELSE ''
      END,
      v_linea_local_id, v_liq.id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
    v_locales_pagaron := array_append(v_locales_pagaron, v_linea_local_id);
  END LOOP;

  -- AUDIT FIX #7: pagado_at/pagado_por solo se setean al completar.
  -- En sucesivos parciales NO se tocan. _resync (al anular) tampoco los blanquea.
  UPDATE rrhh_liquidaciones
     SET pagos_realizados = v_nuevos_pagos,
         estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
         pagado_at = CASE
           WHEN v_completa AND pagado_at IS NULL THEN p_fecha::timestamptz
           ELSE pagado_at
         END,
         pagado_por = CASE
           WHEN v_completa AND pagado_por IS NULL THEN auth_usuario_id()::text
           ELSE pagado_por
         END
   WHERE id = v_liq.id;

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    UPDATE rrhh_adelantos
       SET descontado = true,
           liquidacion_consumidora_id = v_liq.id
     WHERE id = ANY(p_adelantos_ids);
  END IF;

  -- Aguinaldo: total_a_pagar / 12 (sueldo real). El sobrepago NO suma aguinaldo.
  IF v_completa THEN
    UPDATE rrhh_empleados
       SET aguinaldo_acumulado = COALESCE(aguinaldo_acumulado, 0) + v_total_a_pagar / 12.0
     WHERE id = v_emp.id;
  END IF;

  PERFORM _auditar('rrhh_liquidaciones', 'PAGO', jsonb_build_object(
    'liquidacion_id', v_liq.id, 'monto_asignado', v_asignado_total,
    'sobrepago', v_sobrepago,
    'completa', v_completa, 'mov_ids', v_mov_ids,
    'cuota_num', v_liq.cuota_num, 'cuotas_total', v_liq.cuotas_total,
    'adelantos_ids', p_adelantos_ids, 'usuario_id', auth_usuario_id(),
    'locales_pagaron', v_locales_pagaron,
    'pago_repartido', (array_length(ARRAY(SELECT DISTINCT unnest(v_locales_pagaron)), 1) > 1)
  ), v_tenant);

  v_result := jsonb_build_object(
    'liquidacion_id', v_liq.id,
    'mov_ids', v_mov_ids,
    'completa', v_completa,
    'pagos_realizados', v_nuevos_pagos,
    'pendiente', GREATEST(0, v_total_a_pagar - v_nuevos_pagos),
    'sobrepago', v_sobrepago,
    'cuota_num', v_liq.cuota_num,
    'cuotas_total', v_liq.cuotas_total,
    'locales_pagaron', v_locales_pagaron
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('pagar_sueldo', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$
;

NOTIFY pgrst, 'reload schema';
