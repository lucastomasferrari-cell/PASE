-- ═══════════════════════════════════════════════════════════════════════════
-- F8 (parte 2/2) — Idempotency en pagar_sueldo y crear_gasto.
--
-- Contexto: F8 del plan sunny-creek pide idempotency en las 4 RPCs
-- financieras (pagar_factura, pagar_remito, pagar_sueldo, crear_gasto).
-- Las dos primeras se cerraron en migration 202605091220 con el patrón
-- "movimientos.idempotency_key + UNIQUE INDEX". Esta migration cierra
-- las dos restantes:
--
--   - pagar_sueldo: patrón B (tabla idempotency_keys con result cacheado)
--     porque la RPC crea N movimientos (uno por forma de pago), no es
--     trivial identificarla por un solo movimiento.
--   - crear_gasto: patrón A (movimientos.idempotency_key) idéntico a
--     pagar_factura — crea exactamente UN movimiento + UN gasto.
--
-- Ambas RPCs aceptan p_idempotency_key TEXT DEFAULT NULL al final. Las
-- llamadas SIN la key (frontend pre-deploy) siguen funcionando igual.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. pagar_sueldo — agregar p_idempotency_key (patrón B) ────────────────
-- Mantiene firma + lógica idéntica a 202604281206:330. Solo agrega:
--   - p_idempotency_key TEXT DEFAULT NULL al final.
--   - Idempotency check al inicio: si la key ya está en idempotency_keys
--     para rpc_name='pagar_sueldo', devuelve el resultado cacheado.
--   - Persist del resultado JSONB al final con ON CONFLICT DO NOTHING.
CREATE OR REPLACE FUNCTION pagar_sueldo(
  p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[],
  p_fecha date, p_mes integer, p_anio integer,
  p_crear_liq boolean DEFAULT false, p_calc jsonb DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_emp RECORD; v_liq RECORD; v_fp jsonb; v_monto numeric; v_cuenta text;
  v_asignado_cash numeric := 0; v_total_adelantos numeric := 0;
  v_total_a_pagar numeric; v_ya_pagado numeric; v_pendiente numeric;
  v_asignado_total numeric; v_completa boolean; v_nuevos_pagos numeric;
  v_mov_ids text[] := ARRAY[]::text[]; v_mov_id text; v_desc text;
  v_meses_nombre text[] := ARRAY['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  v_tenant uuid;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  -- Idempotency check (convención C1).
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

  SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
  IF v_liq IS NULL THEN
    IF NOT p_crear_liq OR p_calc IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
    INSERT INTO rrhh_liquidaciones (
      novedad_id, sueldo_base, descuento_ausencias, total_horas_extras,
      total_dobles, total_feriados, total_vacaciones, subtotal1,
      monto_presentismo, subtotal2, adelantos, pagos_realizados,
      total_a_pagar, efectivo, transferencia, estado, calculado_at, tenant_id
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
      'pendiente', now(), v_tenant
    ) RETURNING * INTO v_liq;
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
  IF v_asignado_total > v_pendiente THEN RAISE EXCEPTION 'MONTO_EXCEDE_PENDIENTE'; END IF;

  v_completa := v_asignado_total >= v_pendiente;
  v_nuevos_pagos := v_ya_pagado + v_asignado_total;
  v_desc := CASE
    WHEN v_completa AND v_ya_pagado = 0 THEN 'Sueldo'
    WHEN v_completa THEN 'Sueldo (saldo final)'
    ELSE 'Sueldo (parcial)'
  END || ' ' || v_emp.apellido || ' ' || v_emp.nombre
    || ' - ' || v_meses_nombre[p_mes+1] || ' ' || p_anio;

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_fp->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, liquidacion_id, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Sueldo', 'SUELDOS',
      -v_monto, v_desc, v_emp.local_id, v_liq.id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  UPDATE rrhh_liquidaciones
     SET pagos_realizados = v_nuevos_pagos,
         estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
         pagado_at = CASE WHEN v_completa THEN now() ELSE pagado_at END,
         pagado_por = CASE WHEN v_completa THEN auth_usuario_id()::text ELSE pagado_por END
   WHERE id = v_liq.id;

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    UPDATE rrhh_adelantos SET descontado = true WHERE id = ANY(p_adelantos_ids);
  END IF;

  IF v_completa THEN
    UPDATE rrhh_empleados
       SET aguinaldo_acumulado = COALESCE(aguinaldo_acumulado, 0) + v_total_a_pagar / 12.0
     WHERE id = v_emp.id;
  END IF;

  PERFORM _auditar('rrhh_liquidaciones', 'PAGO', jsonb_build_object(
    'liquidacion_id', v_liq.id, 'monto_asignado', v_asignado_total,
    'completa', v_completa, 'mov_ids', v_mov_ids,
    'adelantos_ids', p_adelantos_ids, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  v_result := jsonb_build_object(
    'liquidacion_id', v_liq.id,
    'mov_ids', v_mov_ids,
    'completa', v_completa,
    'pagos_realizados', v_nuevos_pagos,
    'pendiente', GREATEST(0, v_total_a_pagar - v_nuevos_pagos)
  );

  -- Guardar resultado para reproducir en idempotent replay.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('pagar_sueldo', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- ─── 2. crear_gasto — agregar p_idempotency_key (patrón A) ─────────────────
-- Mantiene firma + lógica idéntica a 202604281206:172. Solo agrega:
--   - p_idempotency_key TEXT DEFAULT NULL al final.
--   - Si la key ya existe en movimientos (gasto previo), devuelve {gasto_id,
--     mov_id, idempotent_replay:true} sin re-crear.
--   - Persiste idempotency_key en la fila de movimientos.
CREATE OR REPLACE FUNCTION crear_gasto(
  p_fecha date, p_local_id integer, p_categoria text, p_tipo text,
  p_monto numeric, p_detalle text, p_cuenta text,
  p_plantilla_id integer DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_gasto_id text; v_mov_id text; v_grupo text; v_tipo_final text;
  v_tenant uuid;
  v_existing_mov RECORD;
BEGIN
  -- Idempotency: si ya hay un movimiento con esta key y gasto_id_ref, replay.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, gasto_id_ref INTO v_existing_mov FROM movimientos
     WHERE idempotency_key = p_idempotency_key
       AND tipo LIKE 'Gasto %'
       AND gasto_id_ref IS NOT NULL;
    IF v_existing_mov.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'gasto_id', v_existing_mov.gasto_id_ref,
        'mov_id',   v_existing_mov.id,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR p_categoria = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  IF p_local_id IS NOT NULL THEN
    SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;
  ELSE
    v_tenant := auth_tenant_id();
    IF v_tenant IS NULL THEN
      SELECT id INTO v_tenant FROM tenants WHERE slug='neko' LIMIT 1;
    END IF;
  END IF;

  SELECT grupo INTO v_grupo FROM config_categorias
   WHERE nombre = p_categoria AND tipo LIKE 'gasto_%' AND activo = true LIMIT 1;
  v_tipo_final := CASE v_grupo
    WHEN 'Gastos Fijos'     THEN 'fijo'
    WHEN 'Gastos Variables' THEN 'variable'
    WHEN 'Publicidad y MKT' THEN 'publicidad'
    WHEN 'Comisiones'       THEN 'comision'
    WHEN 'Impuestos'        THEN 'impuesto'
    ELSE p_tipo
  END;

  v_gasto_id := _gen_id('GASTO');
  INSERT INTO gastos (id, fecha, local_id, categoria, tipo, monto, detalle, cuenta, plantilla_id, tenant_id)
  VALUES (v_gasto_id, p_fecha, p_local_id, p_categoria, v_tipo_final, p_monto, p_detalle, p_cuenta, p_plantilla_id, v_tenant);

  IF p_local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle, local_id, gasto_id_ref, tenant_id,
    idempotency_key
  ) VALUES (
    v_mov_id, p_fecha, p_cuenta, 'Gasto ' || COALESCE(v_tipo_final, ''),
    p_categoria, -p_monto, COALESCE(p_detalle, p_categoria), p_local_id, v_gasto_id, v_tenant,
    p_idempotency_key
  );

  PERFORM _auditar('gastos', 'CREAR', jsonb_build_object(
    'gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'monto', p_monto,
    'categoria', p_categoria, 'tipo', v_tipo_final, 'grupo', v_grupo,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'tipo', v_tipo_final);
END;
$$;
