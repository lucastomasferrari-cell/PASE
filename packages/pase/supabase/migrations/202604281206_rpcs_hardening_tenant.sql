-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — ETAPA 4: RPCs hardening multi-tenant.
--
-- Estado pre-migration: las RPCs hacen INSERTs en tablas con tenant_id NOT
-- NULL (etapa 2) sin pasar tenant_id explícito → todas las acciones del
-- frontend que disparan RPCs (crear movimiento/gasto, pagar factura/remito,
-- pagar sueldo, transferir, etc) están ROTAS desde etapa 2.
--
-- Diagnóstico: crear_movimiento_caja falla con
-- "null value in column tenant_id of relation saldos_caja violates not-null
-- constraint" — confirmado vía test directo con JWT de Lucas.
--
-- Fix: cada RPC deriva v_tenant del p_local_id (o de la entidad operada)
-- y lo pasa en cada INSERT. Helpers _actualizar_saldo_caja y _auditar
-- también se modifican para incluir tenant_id.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Helper internos ───────────────────────────────────────────────────

-- _actualizar_saldo_caja: deriva tenant del local_id internamente.
CREATE OR REPLACE FUNCTION _actualizar_saldo_caja(
  p_cuenta text,
  p_local_id integer,
  p_delta numeric,
  p_permitir_negativo boolean DEFAULT true
) RETURNS numeric
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_saldo_final numeric;
  v_tenant uuid;
BEGIN
  -- Derivar tenant del local. Defensive: si el local no existe, fallback a Neko.
  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;
  IF v_tenant IS NULL THEN
    SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
  END IF;

  INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
  VALUES (p_cuenta, p_local_id, p_delta, v_tenant)
  ON CONFLICT (cuenta, local_id) DO UPDATE
  SET saldo = COALESCE(saldos_caja.saldo, 0) + p_delta
  RETURNING saldo INTO v_saldo_final;

  IF v_saldo_final < 0 THEN
    IF NOT p_permitir_negativo THEN
      RAISE EXCEPTION 'SALDO_INSUFICIENTE';
    END IF;
    BEGIN
      INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
      VALUES ('saldos_caja', 'WARN_SALDO_NEGATIVO',
        jsonb_build_object(
          'cuenta', p_cuenta, 'local_id', p_local_id,
          'saldo_final', v_saldo_final, 'delta', p_delta,
          'usuario_id', auth_usuario_id()
        )::text, now(), v_tenant);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN v_saldo_final;
END;
$$;

-- _auditar: agregar p_tenant_id parameter.
-- DROP la versión vieja (3 args) para evitar overload ambiguo: PERFORM
-- _auditar(t, a, d) sin tenant_id no resuelve si conviven dos firmas.
DROP FUNCTION IF EXISTS _auditar(text, text, jsonb);

-- Default: COALESCE(auth_tenant_id(), neko_uuid). Acepta NULL desde callers
-- pre-multitenant (compat) — en ese caso usa el tenant del caller logueado.
CREATE OR REPLACE FUNCTION _auditar(
  p_tabla text,
  p_accion text,
  p_detalle jsonb,
  p_tenant_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := COALESCE(p_tenant_id, auth_tenant_id());
  -- Fallback defensive: si auth_tenant_id() es NULL (superadmin sin override
  -- o context sin JWT), usar tenant Neko. Mantiene la auditoría aunque sea
  -- en el tenant default.
  IF v_tenant IS NULL THEN
    SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
  END IF;
  BEGIN
    INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
    VALUES (p_tabla, p_accion, p_detalle::text, now(), v_tenant);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;

-- _validar_local_autorizado: además de verificar local visible, validar que
-- el local pertenece al tenant del caller (defense-in-depth contra
-- TENANT_MISMATCH cross-tenant).
CREATE OR REPLACE FUNCTION _validar_local_autorizado(p_local_id integer)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_local_tenant uuid;
  v_caller_tenant uuid;
BEGIN
  IF p_local_id IS NULL THEN RETURN; END IF;

  -- Tenant del local.
  SELECT tenant_id INTO v_local_tenant FROM locales WHERE id = p_local_id;
  IF v_local_tenant IS NULL THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  -- Superadmin puede operar en cualquier tenant.
  IF auth_es_superadmin() THEN RETURN; END IF;

  -- Validar tenant match.
  v_caller_tenant := auth_tenant_id();
  IF v_caller_tenant IS NULL OR v_caller_tenant != v_local_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  -- Validar que el caller dueño/admin tiene acceso. (Encargado pasa solo si
  -- el local está en sus locales visibles.)
  IF auth_es_dueno_o_admin() THEN RETURN; END IF;
  IF NOT (p_local_id = ANY(COALESCE(auth_locales_visibles(), ARRAY[]::int[]))) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;
END;
$$;

-- ─── 2. RPCs grandes ──────────────────────────────────────────────────────

-- crear_movimiento_caja
CREATE OR REPLACE FUNCTION crear_movimiento_caja(
  p_fecha date, p_cuenta text, p_tipo text, p_cat text,
  p_importe numeric, p_detalle text, p_local_id integer
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_mov_id text;
  v_tenant uuid;
BEGIN
  IF p_importe IS NULL OR p_importe = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;

  PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, p_importe);

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, p_tipo, p_cat, p_importe, p_detalle, p_local_id, v_tenant);

  PERFORM _auditar('movimientos', 'CREAR', jsonb_build_object(
    'mov_id', v_mov_id, 'importe', p_importe, 'cuenta', p_cuenta,
    'local_id', p_local_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id);
END;
$$;

-- crear_gasto
CREATE OR REPLACE FUNCTION crear_gasto(
  p_fecha date, p_local_id integer, p_categoria text, p_tipo text,
  p_monto numeric, p_detalle text, p_cuenta text,
  p_plantilla_id integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_gasto_id text; v_mov_id text; v_grupo text; v_tipo_final text;
  v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR p_categoria = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  -- Si p_local_id NULL (gasto global del dueño), derivar tenant del caller.
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
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, gasto_id_ref, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Gasto ' || COALESCE(v_tipo_final, ''),
    p_categoria, -p_monto, COALESCE(p_detalle, p_categoria), p_local_id, v_gasto_id, v_tenant);

  PERFORM _auditar('gastos', 'CREAR', jsonb_build_object(
    'gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'monto', p_monto,
    'categoria', p_categoria, 'tipo', v_tipo_final, 'grupo', v_grupo,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'tipo', v_tipo_final);
END;
$$;

-- pagar_factura
CREATE OR REPLACE FUNCTION pagar_factura(
  p_factura_id text, p_monto numeric, p_cuenta text, p_fecha date,
  p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_fac RECORD; v_nuevos_pagos jsonb; v_total_pagado numeric;
  v_nuevo_estado text; v_mov_id text; v_detalle text; v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('cuenta', p_cuenta, 'monto', p_monto, 'fecha', p_fecha));
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;
  v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos WHERE id = p_factura_id;

  IF v_fac.prov_id IS NOT NULL THEN
    UPDATE proveedores SET saldo = GREATEST(0, COALESCE(saldo, 0) - p_monto) WHERE id = v_fac.prov_id;
  END IF;

  IF v_fac.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_fac.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  v_detalle := COALESCE(p_detalle, 'Pago Fact ' || COALESCE(v_fac.nro, v_fac.id));
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, fact_id, local_id, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_fac.cat,
    -p_monto, v_detalle, p_factura_id, v_fac.local_id, v_tenant);

  PERFORM _auditar('facturas', 'PAGO', jsonb_build_object(
    'factura_id', p_factura_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado, 'total_pagado', v_total_pagado);
END;
$$;

-- pagar_remito
CREATE OR REPLACE FUNCTION pagar_remito(
  p_remito_id text, p_monto numeric, p_cuenta text, p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_r RECORD; v_prov RECORD; v_mov_id text; v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_ANULADO'; END IF;
  IF v_r.estado = 'pagado' THEN RAISE EXCEPTION 'REMITO_YA_PAGADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  UPDATE remitos SET estado = 'pagado' WHERE id = p_remito_id;

  SELECT * INTO v_prov FROM proveedores WHERE id = v_r.prov_id;
  IF v_prov.id IS NOT NULL THEN
    UPDATE proveedores SET saldo = GREATEST(0, COALESCE(saldo, 0) - p_monto) WHERE id = v_r.prov_id;
  END IF;

  IF v_r.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_r.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, remito_id_ref, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_r.cat, -p_monto,
    'Pago remito ' || COALESCE(v_r.nro, v_r.id) || COALESCE(' - ' || v_prov.nombre, ''),
    v_r.local_id, p_remito_id, v_tenant);

  PERFORM _auditar('remitos', 'PAGO', jsonb_build_object(
    'remito_id', p_remito_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', 'pagado');
END;
$$;

-- pagar_sueldo
CREATE OR REPLACE FUNCTION pagar_sueldo(
  p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[],
  p_fecha date, p_mes integer, p_anio integer,
  p_crear_liq boolean DEFAULT false, p_calc jsonb DEFAULT NULL
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
BEGIN
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
    'liq_id', v_liq.id, 'nov_id', p_nov_id, 'emp_id', v_emp.id,
    'monto_asignado', v_asignado_total, 'completa', v_completa,
    'mov_ids', to_jsonb(v_mov_ids), 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object(
    'liq_id', v_liq.id, 'mov_ids', to_jsonb(v_mov_ids),
    'completa', v_completa, 'pagos_realizados', v_nuevos_pagos
  );
END;
$$;

-- pagar_aguinaldo
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
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, gasto_id, pagado_por, tenant_id)
  VALUES (v_pago_id, p_empleado_id, 'aguinaldo',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    NULL, COALESCE(auth_usuario_id()::text, 'rpc'), v_tenant);

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

  PERFORM _auditar('rrhh_pagos_especiales', 'AGUINALDO', jsonb_build_object(
    'pago_id', v_pago_id, 'emp_id', p_empleado_id, 'total_pagado', v_total_pagado,
    'mov_ids', to_jsonb(v_mov_ids), 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$$;

-- pagar_vacaciones
CREATE OR REPLACE FUNCTION pagar_vacaciones(
  p_empleado_id uuid, p_lineas jsonb, p_dias numeric,
  p_monto_esperado numeric, p_fecha date
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

  IF p_dias IS NULL OR p_dias <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Vacaciones ' || v_emp.apellido || ' ' || v_emp.nombre;

  v_pago_id := gen_random_uuid();
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, dias, gasto_id, pagado_por, tenant_id)
  VALUES (v_pago_id, p_empleado_id, 'vacaciones',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    p_dias, NULL, COALESCE(auth_usuario_id()::text, 'rpc'), v_tenant);

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
    UPDATE rrhh_empleados SET vacaciones_dias_acumulados = 0 WHERE id = p_empleado_id;
  END IF;

  PERFORM _auditar('rrhh_pagos_especiales', 'VACACIONES', jsonb_build_object(
    'pago_id', v_pago_id, 'emp_id', p_empleado_id, 'total_pagado', v_total_pagado,
    'mov_ids', to_jsonb(v_mov_ids), 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$$;

-- liquidacion_final_empleado
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
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, gasto_id, pagado_por, tenant_id)
  VALUES (v_pago_id, p_empleado_id, 'liquidacion_final', p_total, NULL,
    COALESCE(auth_usuario_id()::text, 'rpc'), v_tenant);

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

-- registrar_adelanto
CREATE OR REPLACE FUNCTION registrar_adelanto(
  p_empleado_id uuid, p_monto numeric, p_cuenta text, p_fecha date,
  p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_emp RECORD; v_mov_id text; v_adel_id uuid; v_detalle text;
  v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  v_detalle := COALESCE(
    'Adelanto ' || v_emp.apellido || ' ' || v_emp.nombre
      || CASE WHEN p_detalle IS NOT NULL AND p_detalle <> '' THEN ' — ' || p_detalle ELSE '' END,
    'Adelanto'
  );

  IF v_emp.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_emp.local_id, -p_monto);
  END IF;

  INSERT INTO rrhh_adelantos (empleado_id, monto, fecha, local_id, cuenta, descontado, registrado_por, tenant_id)
  VALUES (p_empleado_id, p_monto, p_fecha, v_emp.local_id, p_cuenta, false,
    COALESCE(v_emp.apellido, ''), v_tenant)
  RETURNING id INTO v_adel_id;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, adelanto_id_ref, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Adelanto', 'SUELDOS', -p_monto, v_detalle, v_emp.local_id, v_adel_id, v_tenant);

  PERFORM _auditar('rrhh_adelantos', 'CREAR', jsonb_build_object(
    'adel_id', v_adel_id, 'emp_id', p_empleado_id, 'monto', p_monto,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('adel_id', v_adel_id, 'mov_id', v_mov_id);
END;
$$;

-- transferencia_cuentas
CREATE OR REPLACE FUNCTION transferencia_cuentas(
  p_local_id integer, p_cuenta_origen text, p_cuenta_destino text,
  p_monto numeric, p_fecha date, p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_mov_out text; v_mov_in text; v_detalle text;
  v_transf_id uuid := gen_random_uuid(); v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta_origen IS NULL OR p_cuenta_origen = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_cuenta_destino IS NULL OR p_cuenta_destino = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_cuenta_origen = p_cuenta_destino THEN RAISE EXCEPTION 'CUENTAS_IGUALES'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;

  v_detalle := COALESCE(p_detalle, 'Transferencia ' || p_cuenta_origen || ' → ' || p_cuenta_destino);

  PERFORM _actualizar_saldo_caja(p_cuenta_origen, p_local_id, -p_monto);
  PERFORM _actualizar_saldo_caja(p_cuenta_destino, p_local_id, p_monto);

  v_mov_out := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id, tenant_id)
  VALUES (v_mov_out, p_fecha, p_cuenta_origen, 'Transferencia Salida', NULL,
    -p_monto, v_detalle, p_local_id, v_transf_id, v_tenant);

  v_mov_in := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id, tenant_id)
  VALUES (v_mov_in, p_fecha, p_cuenta_destino, 'Transferencia Entrada', NULL,
    p_monto, v_detalle, p_local_id, v_transf_id, v_tenant);

  PERFORM _auditar('movimientos', 'TRANSFERENCIA', jsonb_build_object(
    'mov_out', v_mov_out, 'mov_in', v_mov_in, 'monto', p_monto,
    'origen', p_cuenta_origen, 'destino', p_cuenta_destino,
    'transferencia_id', v_transf_id, 'local_id', p_local_id,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_out', v_mov_out, 'mov_in', v_mov_in, 'transferencia_id', v_transf_id);
END;
$$;

-- ─── 3. RPCs sobre ventas (eliminar/editar/cierre) ─────────────────────────
-- Estas no insertan filas nuevas en tablas con tenant_id NOT NULL (operan
-- DELETE/UPDATE sobre filas existentes que ya tienen tenant_id). Solo
-- necesitan pasar tenant_id a _auditar.

-- eliminar_venta
CREATE OR REPLACE FUNCTION eliminar_venta(p_venta_id text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_venta RECORD; v_mov RECORD; v_saldo_delta numeric := 0;
  v_mov_borrado boolean := false; v_tenant uuid;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN RAISE EXCEPTION 'VENTA_ID_REQUERIDO'; END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  v_tenant := v_venta.tenant_id;

  SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[p_venta_id]::text[] LIMIT 1;

  IF v_mov.id IS NOT NULL THEN
    IF array_length(v_mov.venta_ids, 1) = 1 THEN
      DELETE FROM movimientos WHERE id = v_mov.id;
      v_saldo_delta := v_mov.importe;
      v_mov_borrado := true;
    ELSE
      UPDATE movimientos
         SET importe = importe - v_venta.monto,
             venta_ids = array_remove(venta_ids, p_venta_id)
       WHERE id = v_mov.id;
      v_saldo_delta := v_venta.monto;
    END IF;
    IF v_mov.local_id IS NOT NULL THEN
      UPDATE saldos_caja SET saldo = saldo - v_saldo_delta
       WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
    END IF;
  END IF;

  DELETE FROM ventas WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'ELIMINAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id, 'monto', v_venta.monto, 'medio', v_venta.medio,
    'local_id', v_venta.local_id, 'fecha', v_venta.fecha, 'turno', v_venta.turno,
    'mov_id', v_mov.id, 'mov_borrado', v_mov_borrado,
    'saldo_delta', v_saldo_delta, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('venta_id', p_venta_id, 'mov_id', v_mov.id,
    'mov_borrado', v_mov_borrado, 'saldo_delta', v_saldo_delta);
END;
$$;

-- editar_venta
CREATE OR REPLACE FUNCTION editar_venta(p_venta_id text, p_nuevo_monto numeric)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_venta RECORD; v_mov RECORD; v_delta numeric; v_tenant uuid;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN RAISE EXCEPTION 'VENTA_ID_REQUERIDO'; END IF;
  IF p_nuevo_monto IS NULL OR p_nuevo_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  v_tenant := v_venta.tenant_id;

  v_delta := p_nuevo_monto - v_venta.monto;
  IF v_delta != 0 THEN
    SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[p_venta_id]::text[] LIMIT 1;
    IF v_mov.id IS NOT NULL THEN
      UPDATE movimientos SET importe = importe + v_delta WHERE id = v_mov.id;
      IF v_mov.local_id IS NOT NULL THEN
        UPDATE saldos_caja SET saldo = saldo + v_delta
         WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
      END IF;
    END IF;
  END IF;

  UPDATE ventas SET monto = p_nuevo_monto WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'EDITAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id, 'monto_anterior', v_venta.monto,
    'monto_nuevo', p_nuevo_monto, 'delta', v_delta,
    'local_id', v_venta.local_id, 'mov_id', v_mov.id,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('venta_id', p_venta_id, 'monto_nuevo', p_nuevo_monto,
    'delta', v_delta, 'mov_ajustado', v_mov.id IS NOT NULL);
END;
$$;

-- eliminar_cierre
CREATE OR REPLACE FUNCTION eliminar_cierre(p_local_id integer, p_fecha date, p_turno text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_venta RECORD; v_mov RECORD; v_saldo_delta numeric;
  v_ventas_borradas int := 0; v_movs_borrados int := 0;
  v_movs_actualizados int := 0; v_contiene_legacy boolean := false;
  v_venta_ids_borrados text[] := ARRAY[]::text[];
  v_total_borrado numeric := 0; v_tenant uuid;
BEGIN
  IF p_local_id IS NULL OR p_fecha IS NULL OR p_turno IS NULL OR length(p_turno) = 0 THEN
    RAISE EXCEPTION 'PARAMETROS_REQUERIDOS';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;

  FOR v_venta IN
    SELECT * FROM ventas
     WHERE local_id = p_local_id AND fecha = p_fecha AND turno = p_turno
     ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[v_venta.id]::text[] LIMIT 1;
    IF v_mov.id IS NOT NULL THEN
      IF array_length(v_mov.venta_ids, 1) = 1 THEN
        DELETE FROM movimientos WHERE id = v_mov.id;
        v_saldo_delta := v_mov.importe;
        v_movs_borrados := v_movs_borrados + 1;
      ELSE
        UPDATE movimientos
           SET importe = importe - v_venta.monto,
               venta_ids = array_remove(venta_ids, v_venta.id)
         WHERE id = v_mov.id;
        v_saldo_delta := v_venta.monto;
        v_movs_actualizados := v_movs_actualizados + 1;
      END IF;
      IF v_mov.local_id IS NOT NULL THEN
        UPDATE saldos_caja SET saldo = saldo - v_saldo_delta
         WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
      END IF;
    ELSE
      v_contiene_legacy := true;
    END IF;
    DELETE FROM ventas WHERE id = v_venta.id;
    v_ventas_borradas := v_ventas_borradas + 1;
    v_venta_ids_borrados := array_append(v_venta_ids_borrados, v_venta.id);
    v_total_borrado := v_total_borrado + v_venta.monto;
  END LOOP;

  IF v_ventas_borradas = 0 THEN RAISE EXCEPTION 'CIERRE_NO_ENCONTRADO'; END IF;

  PERFORM _auditar('ventas', 'ELIMINAR_CIERRE', jsonb_build_object(
    'local_id', p_local_id, 'fecha', p_fecha, 'turno', p_turno,
    'ventas_borradas', v_ventas_borradas, 'venta_ids', v_venta_ids_borrados,
    'monto_total_borrado', v_total_borrado,
    'movimientos_borrados', v_movs_borrados,
    'movimientos_actualizados', v_movs_actualizados,
    'contiene_legacy', v_contiene_legacy, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('ventas_borradas', v_ventas_borradas,
    'movimientos_borrados', v_movs_borrados,
    'movimientos_actualizados', v_movs_actualizados,
    'contiene_legacy', v_contiene_legacy,
    'monto_total_borrado', v_total_borrado);
END;
$$;

-- ─── 4. set_mp_token ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_mp_token(p_local_id integer, p_access_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id int; v_token_encrypted bytea; v_token_last8 text; v_tenant uuid;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_INVALIDO'; END IF;
  IF p_access_token IS NULL OR length(p_access_token) < 10 THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;

  -- Validar tenant del local matchea con caller (defense-in-depth).
  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;
  IF NOT auth_es_superadmin() AND v_tenant != auth_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  v_token_encrypted := pgp_sym_encrypt(p_access_token, _get_mp_passphrase());
  v_token_last8 := right(p_access_token, 8);

  INSERT INTO mp_credenciales (local_id, access_token, access_token_encrypted, access_token_last8, activo, tenant_id)
  VALUES (p_local_id, p_access_token, v_token_encrypted, v_token_last8, true, v_tenant)
  ON CONFLICT (local_id) DO UPDATE
    SET access_token = EXCLUDED.access_token,
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        access_token_last8 = EXCLUDED.access_token_last8,
        activo = true
  RETURNING id INTO v_id;

  PERFORM _auditar('mp_credenciales', 'UPSERT', jsonb_build_object(
    'cred_id', v_id, 'local_id', p_local_id,
    'token_last8', v_token_last8, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('id', v_id, 'token_last8', v_token_last8);
END;
$$;

-- ─── 5. RPCs anular_* ─────────────────────────────────────────────────────
-- Solo modifican filas existentes (UPDATE), no insertan tenant_id nuevo.
-- _validar_local_autorizado ya valida tenant. Solo agregamos v_tenant a _auditar.

-- anular_movimiento (versión actualizada con tenant_id en _auditar)
CREATE OR REPLACE FUNCTION anular_movimiento(p_mov_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_mov RECORD; v_pareja RECORD; v_gasto_id text;
  v_anulados text[] := ARRAY[]::text[]; v_tenant uuid;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);
  v_tenant := v_mov.tenant_id;

  IF v_mov.transferencia_id IS NOT NULL THEN
    FOR v_pareja IN SELECT * FROM movimientos
     WHERE transferencia_id = v_mov.transferencia_id AND anulado IS DISTINCT FROM TRUE
     ORDER BY id LOOP
      PERFORM _validar_local_autorizado(v_pareja.local_id);
      UPDATE movimientos SET anulado = true, anulado_motivo = p_motivo WHERE id = v_pareja.id;
      IF v_pareja.local_id IS NOT NULL THEN
        PERFORM _actualizar_saldo_caja(v_pareja.cuenta, v_pareja.local_id, -COALESCE(v_pareja.importe, 0));
      END IF;
      v_anulados := array_append(v_anulados, v_pareja.id);
    END LOOP;

    PERFORM _auditar('movimientos', 'ANULACION_TRANSFERENCIA', jsonb_build_object(
      'mov_id_solicitado', p_mov_id, 'transferencia_id', v_mov.transferencia_id,
      'movs_anulados', to_jsonb(v_anulados), 'motivo', p_motivo,
      'usuario_id', auth_usuario_id()
    ), v_tenant);

    RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true,
      'transferencia_id', v_mov.transferencia_id, 'movs_anulados', to_jsonb(v_anulados));
  END IF;

  UPDATE movimientos SET anulado = true, anulado_motivo = p_motivo WHERE id = p_mov_id;
  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  IF v_mov.liquidacion_id IS NOT NULL THEN
    UPDATE rrhh_liquidaciones SET anulado = true WHERE id = v_mov.liquidacion_id;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
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
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$$;

-- anular_factura
CREATE OR REPLACE FUNCTION anular_factura(p_factura_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_fac RECORD; v_tenant uuid;
BEGIN
  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_YA_ANULADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  UPDATE facturas SET estado = 'anulada' WHERE id = p_factura_id;

  IF v_fac.prov_id IS NOT NULL AND v_fac.estado <> 'pagada' THEN
    UPDATE proveedores SET saldo = GREATEST(0, COALESCE(saldo, 0) - COALESCE(v_fac.total, 0))
     WHERE id = v_fac.prov_id;
  END IF;

  PERFORM _auditar('facturas', 'ANULACION', jsonb_build_object(
    'factura_id', p_factura_id, 'motivo', p_motivo,
    'estado_previo', v_fac.estado, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada');
END;
$$;

-- anular_remito
CREATE OR REPLACE FUNCTION anular_remito(p_remito_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_r RECORD; v_tenant uuid;
BEGIN
  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  UPDATE remitos SET estado = 'anulado' WHERE id = p_remito_id;

  IF v_r.estado = 'sin_factura' AND v_r.prov_id IS NOT NULL THEN
    UPDATE proveedores SET saldo = GREATEST(0, COALESCE(saldo, 0) - COALESCE(v_r.monto, 0))
     WHERE id = v_r.prov_id;
  END IF;

  PERFORM _auditar('remitos', 'ANULACION', jsonb_build_object(
    'remito_id', p_remito_id, 'motivo', p_motivo,
    'estado_previo', v_r.estado, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('remito_id', p_remito_id, 'estado', 'anulado');
END;
$$;
