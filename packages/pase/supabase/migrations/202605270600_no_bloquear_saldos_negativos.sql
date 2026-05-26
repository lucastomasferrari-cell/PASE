-- ─────────────────────────────────────────────────────────────────────────
-- No bloquear pagos por saldo negativo (sprint 27-may noche).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Pedido Lucas 27-may noche: "cuando un usuario quiere hacer un pago
-- desde una cuenta que tiene saldo negativo, en este caso las cuentas
-- de mercado pago o de banco, les da un error, como que el saldo es
-- insuficiente, deberíamos sacar en las cajas la función de que no se
-- pueda hacer movimientos si el saldo es negativo".
--
-- Por qué saco el check:
--   1. Para cuentas MP/Banco: el sistema NO recibe TODOS los ingresos
--      automático (no tenemos sync 1:1 con MP / homebanking). Eso hace
--      que el saldo en PASE sea menor al real → el check bloquea pagos
--      legítimos. La cuenta real SÍ tiene plata.
--   2. Para cuentas Caja física: a veces quedan negativas por temas
--      operativos (vuelto cargado mal, alguien anotó después, etc.).
--      Bloquear pagos NO ayuda — el operador igual sabe lo que está
--      haciendo. Mejor warn que bloquear.
--
-- Lo que hago:
--   - `_actualizar_saldo_caja`: el RAISE de SALDO_INSUFICIENTE sale.
--     Mantengo la auditoría defensiva WARN_SALDO_NEGATIVO (ayuda a
--     detectar problemas sin bloquear UX).
--   - `crear_gasto_empleado`: saca el check `v_saldo_actual < p_monto`.
--   - `pagar_sueldo`: saca el check `v_saldo_disp < v_saldo_req`.
--     Mantengo el check "cuenta NO existe" porque eso sigue siendo un
--     bug genuino (cuenta tipeada mal o catálogo desconfigurado).
--   - NO toco `aplicar_nc_a_factura` porque ese chequea saldo de NC
--     (notas de crédito), no de caja — esa validación SÍ es relevante.

-- ─── 1) _actualizar_saldo_caja: sacar RAISE, mantener auditoría ─────────
CREATE OR REPLACE FUNCTION public._actualizar_saldo_caja(
  p_cuenta text,
  p_local_id integer,
  p_delta numeric,
  p_permitir_negativo boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_saldo numeric;
BEGIN
  SELECT COALESCE(saldo, 0) INTO v_saldo
    FROM saldos_caja
   WHERE cuenta = p_cuenta AND local_id = p_local_id;

  v_saldo := COALESCE(v_saldo, 0);

  -- SACADO 27-may: ya no bloqueamos por saldo negativo.
  -- El parámetro p_permitir_negativo queda en la firma para mantener
  -- compat con callers que lo pasan en false — pero el RAISE ya no se
  -- dispara nunca.
  --
  -- IF v_saldo < 0 AND NOT p_permitir_negativo THEN
  --   RAISE EXCEPTION 'SALDO_INSUFICIENTE';
  -- END IF;

  -- Auditoría defensiva (warn, no bloquea). Si aparecen muchos saldos
  -- negativos en auditoría, es señal de que falta sync MP/banco o de
  -- que hay un bug en alguna RPC — pero el user puede operar igual.
  IF v_saldo < 0 THEN
    BEGIN
      INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
      VALUES ('saldos_caja', 'WARN_SALDO_NEGATIVO',
        jsonb_build_object(
          'cuenta', p_cuenta, 'local_id', p_local_id,
          'saldo_final', v_saldo, 'delta_ignorado', p_delta,
          'usuario_id', auth_usuario_id()
        )::text, now(),
        (SELECT tenant_id FROM locales WHERE id = p_local_id));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN v_saldo;
END;
$$;

-- ─── 2) crear_gasto_empleado: sacar check de saldo ────────────────────
-- Mantengo TODA la lógica original — solo elimino el RAISE 'SALDO_INSUFICIENTE'.
-- Es más simple replicar la función completa que hacer un patch parcial.
CREATE OR REPLACE FUNCTION public.crear_gasto_empleado(
  p_local_id integer,
  p_empleado_id uuid,
  p_concepto text,
  p_monto numeric,
  p_cuenta text,
  p_fecha date,
  p_detalle text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS TABLE(gasto_id text, adelanto_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_emp_local_id INTEGER;
  v_gasto_id TEXT;
  v_adelanto_id UUID;
  v_emp_nombre TEXT;
  v_concepto_label TEXT;
  v_cached JSONB;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_concepto NOT IN ('adelanto','dia_doble','horas_extras','feriado','comida','viatico','otros') THEN
    RAISE EXCEPTION 'CONCEPTO_INVALIDO';
  END IF;
  IF p_cuenta IS NULL OR length(trim(p_cuenta)) = 0 THEN
    RAISE EXCEPTION 'CUENTA_REQUERIDA';
  END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'crear_gasto_empleado' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN
      RETURN QUERY SELECT
        (v_cached->>'gasto_id')::TEXT,
        (v_cached->>'adelanto_id')::UUID;
      RETURN;
    END IF;
  END IF;

  SELECT local_id, nombre INTO v_emp_local_id, v_emp_nombre
    FROM rrhh_empleados
   WHERE id = p_empleado_id
     AND tenant_id = v_tenant_id
     AND COALESCE(activo, TRUE) = TRUE;
  IF v_emp_local_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- SACADO 27-may: ya no bloqueamos por saldo insuficiente en la cuenta.
  -- Razón: las cuentas MP/Banco quedan negativas porque no sincronizamos
  -- todos los ingresos. Cajas físicas a veces quedan negativas por temas
  -- operativos. El operador sabe lo que hace.
  --
  -- SELECT COALESCE(saldo, 0) INTO v_saldo_actual FROM saldos_caja
  --  WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;
  -- IF v_saldo_actual < p_monto THEN
  --   RAISE EXCEPTION 'SALDO_INSUFICIENTE';
  -- END IF;

  v_concepto_label := CASE p_concepto
    WHEN 'adelanto'     THEN 'Adelanto'
    WHEN 'dia_doble'    THEN 'Día doble'
    WHEN 'horas_extras' THEN 'Horas extra'
    WHEN 'feriado'      THEN 'Feriado'
    WHEN 'comida'       THEN 'Comida'
    WHEN 'viatico'      THEN 'Viático'
    WHEN 'otros'        THEN 'Otros'
  END;

  v_gasto_id := gen_random_uuid()::TEXT;
  INSERT INTO gastos (
    id, tenant_id, local_id, fecha, tipo, categoria, monto, detalle, cuenta, estado
  ) VALUES (
    v_gasto_id, v_tenant_id, p_local_id, p_fecha, 'empleado',
    v_concepto_label, p_monto,
    COALESCE(p_detalle, v_emp_nombre || ' — ' || v_concepto_label),
    p_cuenta, 'activo'
  );

  -- FIX 2026-05-25: SOLO crear adelanto si concepto='adelanto'.
  IF p_concepto = 'adelanto' THEN
    INSERT INTO rrhh_adelantos (
      tenant_id, empleado_id, fecha, monto, cuenta,
      descontado, concepto, gasto_id, registrado_por
    ) VALUES (
      v_tenant_id, p_empleado_id, p_fecha, p_monto, p_cuenta,
      FALSE, p_concepto, v_gasto_id, auth.uid()::text
    ) RETURNING id INTO v_adelanto_id;
  ELSE
    v_adelanto_id := NULL;
  END IF;

  UPDATE saldos_caja SET
    saldo = saldo - p_monto
  WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;

  INSERT INTO movimientos (
    id, tenant_id, local_id, fecha, tipo, cat, importe, cuenta, detalle,
    gasto_id_ref, adelanto_id_ref, anulado
  ) VALUES (
    gen_random_uuid()::TEXT, v_tenant_id, p_local_id, p_fecha,
    'Gasto empleado', v_concepto_label, -p_monto, p_cuenta,
    v_emp_nombre || ' — ' || v_concepto_label,
    v_gasto_id, v_adelanto_id, FALSE
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES (
      'crear_gasto_empleado', p_idempotency_key, v_tenant_id,
      jsonb_build_object('gasto_id', v_gasto_id, 'adelanto_id', v_adelanto_id)
    )
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_gasto_id, v_adelanto_id;
END;
$$;

-- ─── 3) pagar_sueldo: sacar check de saldo, mantener "cuenta no existe" ──
-- En lugar de re-emitir la función entera (300+ líneas), uso una técnica
-- safer: NO reemplazo la función — Lucas ya tiene logica defensiva
-- "Skip cuentas no-físicas" que filtra para no chequear saldo en
-- Banco/MP. Lo que queda es solo el check para "Caja %" que es lo que
-- Lucas también quiere sacar.
--
-- Approach pragmático: como la función skipea cuentas no-Caja, el check
-- solo bloquea cuando se paga sueldo en EFECTIVO con caja física vacía.
-- Eso es raro (sueldo en efectivo no es habitual en negro). Y si pasa,
-- es informativo: "Caja Efectivo está vacía, ¿seguro?". Para mantener
-- consistencia con Lucas pedido, comentamos también el check de Caja.
--
-- Hago un OR REPLACE solo del bloque relevante via función envuelta:
-- ahora `_pre_validar_saldos_sueldo` no chequea nada (NOOP). El resto
-- de pagar_sueldo sigue igual.
--
-- Pero pagar_sueldo no usa una función auxiliar — el check está inline.
-- Entonces tengo que re-emitir la función ENTERA. Pesado pero seguro.

CREATE OR REPLACE FUNCTION public.pagar_sueldo(
  p_nov_id uuid,
  p_formas_pago jsonb,
  p_adelantos_ids uuid[],
  p_fecha date,
  p_mes integer,
  p_anio integer,
  p_crear_liq boolean DEFAULT false,
  p_calc jsonb DEFAULT NULL::jsonb,
  p_idempotency_key text DEFAULT NULL::text,
  p_liq_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
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
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'pagar_sueldo' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay', true); END IF;
  END IF;

  IF p_nov_id IS NULL THEN RAISE EXCEPTION 'NOVEDAD_INVALIDA'; END IF;

  SELECT e.* INTO v_emp FROM rrhh_empleados e
    JOIN rrhh_novedades n ON n.empleado_id = e.id
   WHERE n.id = p_nov_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  IF p_liq_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = p_liq_id;
    IF v_liq IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
    IF v_liq.novedad_id IS DISTINCT FROM p_nov_id THEN
      RAISE EXCEPTION 'LIQUIDACION_NOVEDAD_MISMATCH';
    END IF;
  ELSE
    SELECT COUNT(*) INTO v_count_liqs FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
    IF v_count_liqs > 1 THEN
      RAISE EXCEPTION 'MULTIPLES_CUOTAS_REQUIERE_LIQ_ID';
    END IF;
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
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
  v_nuevos_pagos := LEAST(v_total_a_pagar, v_ya_pagado + v_asignado_total);

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

  -- SACADO 27-may: la pre-validación de saldos (Pass 1.5 HOTFIX ALTO-9)
  -- bloqueaba pagos en efectivo cuando la caja física estaba vacía. Por
  -- decisión de Lucas, ya no bloqueamos por saldo negativo en ningún
  -- caso. Las cuentas Banco/MP ya estaban exceptuadas. Ahora tampoco
  -- bloquea Caja física.

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

    IF v_linea_local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_linea_local_id, -v_monto);
    END IF;

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

  UPDATE rrhh_liquidaciones
     SET pagos_realizados = v_nuevos_pagos,
         estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
         pagado_at = CASE WHEN v_completa THEN now() ELSE pagado_at END,
         pagado_por = CASE WHEN v_completa THEN auth_usuario_id()::text ELSE pagado_por END
   WHERE id = v_liq.id;

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    UPDATE rrhh_adelantos
       SET descontado = true,
           liquidacion_consumidora_id = v_liq.id
     WHERE id = ANY(p_adelantos_ids);
  END IF;

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
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;
