-- 202606141600_cashflow_puente.sql
-- Fase 4 del módulo Cashflow (Task 7): el puente devengado ↔ cash (método indirecto).
-- Explica por qué la ganancia del EERR (devengado) ≠ la plata generada (cash):
--   utilNeta devengada − Δstock − Δpor cobrar + Δpor pagar − retiros + aportes − obra = cash.
-- Replica el cálculo del EERR (devengado) y lo cruza con las líneas de capital de
-- trabajo. Read-only, SECURITY DEFINER, auth check.
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_puente_mes(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid;
  v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_mes int := EXTRACT(MONTH FROM p_periodo_mes)::int;
  v_anio int := EXTRACT(YEAR FROM p_periodo_mes)::int;
  v_cuentas text[] := ARRAY['Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES'];
  -- devengado (EERR)
  v_ventas numeric; v_cmv numeric; v_gfijos numeric; v_gvar numeric; v_cargas numeric;
  v_pub numeric; v_com numeric; v_imp numeric; v_otros numeric; v_sueldos numeric; v_util numeric;
  -- capital de trabajo
  v_transito numeric; v_por_pagar numeric; v_retiros numeric := 0; v_aportes numeric := 0; v_obra numeric := 0;
  v_stock numeric := 0; v_cash numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  -- ===== Devengado (réplica EERR.tsx, por fecha del documento) =====
  SELECT coalesce(SUM(monto),0) INTO v_ventas FROM ventas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin;

  SELECT coalesce(SUM(total),0) INTO v_cmv FROM facturas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
     AND (bucket IS NULL OR bucket='cat_compra') AND (estado <> 'anulada' OR estado IS NULL);

  -- gastos por tipo + facturas por bucket
  SELECT
    coalesce(SUM(monto) FILTER (WHERE tipo='fijo' AND coalesce(categoria,'')<>'CARGAS SOCIALES'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='variable'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='fijo' AND categoria='CARGAS SOCIALES'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='publicidad'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='comision'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='impuesto'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo NOT IN ('fijo','variable','publicidad','comision','impuesto','retiro_socio','empleado')),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='empleado'),0)
  INTO v_gfijos, v_gvar, v_cargas, v_pub, v_com, v_imp, v_otros, v_sueldos
  FROM gastos
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
    AND (estado <> 'anulado' OR estado IS NULL);

  -- sumar las facturas cargadas como gasto (bucket gasto_*)
  SELECT
    v_gfijos + coalesce(SUM(total) FILTER (WHERE bucket='gasto_fijo'),0),
    v_gvar   + coalesce(SUM(total) FILTER (WHERE bucket='gasto_variable'),0),
    v_pub    + coalesce(SUM(total) FILTER (WHERE bucket='gasto_publicidad'),0),
    v_com    + coalesce(SUM(total) FILTER (WHERE bucket='gasto_comision'),0),
    v_imp    + coalesce(SUM(total) FILTER (WHERE bucket='gasto_impuesto'),0)
  INTO v_gfijos, v_gvar, v_pub, v_com, v_imp
  FROM facturas
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
    AND (estado <> 'anulada' OR estado IS NULL);

  -- sueldos devengados: liquidaciones del mes (novedad mes/anio), empleados del local
  SELECT coalesce(SUM(liq.total_a_pagar),0) INTO v_sueldos
  FROM rrhh_liquidaciones liq
  JOIN rrhh_novedades nov ON nov.id = liq.novedad_id
  JOIN rrhh_empleados emp ON emp.id = nov.empleado_id
  WHERE liq.tenant_id=v_tenant AND emp.local_id=p_local_id
    AND nov.mes=v_mes AND nov.anio=v_anio
    AND liq.estado IN ('pendiente','pagado') AND liq.anulado=false;
  -- + extra labor cargado como gasto tipo='empleado' (igual que el EERR)
  v_sueldos := v_sueldos + (SELECT coalesce(SUM(monto),0) FROM gastos
      WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
        AND tipo='empleado' AND (estado <> 'anulado' OR estado IS NULL));

  v_util := v_ventas - v_cmv - v_gfijos - v_gvar - v_sueldos - v_cargas - v_pub - v_com - v_imp - v_otros;

  -- ===== Capital de trabajo =====
  -- Δ por cobrar (float): ventas no-efectivo del mes − liquidaciones ya acreditadas (extracto).
  SELECT coalesce(SUM(monto),0) INTO v_transito FROM ventas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
     AND upper(medio) <> 'EFECTIVO';
  v_transito := v_transito - coalesce((
    SELECT SUM(l.monto_bruto) FROM cashflow_lineas l JOIN cashflow_extractos ex ON ex.id=l.extracto_id
    WHERE l.tenant_id=v_tenant AND ex.local_id=p_local_id AND ex.periodo_mes=p_periodo_mes
      AND l.categoria='venta' AND NOT l.es_interno), 0);

  -- Δ por pagar: facturas del mes aún pendientes (deuda nueva no pagada).
  SELECT coalesce(SUM(total),0) INTO v_por_pagar FROM facturas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
     AND estado='pendiente';

  -- Retiros / aportes / obra: del lado cash (efectivo categorizado + extracto).
  WITH cat AS (
    SELECT e.importe AS monto, e.c FROM (
      SELECT m.importe, jc.j->>'categoria' AS c FROM movimientos m
      CROSS JOIN LATERAL (SELECT fn_cashflow_cat_efectivo(v_tenant, m.id, m.tipo, m.detalle, m.importe,
        m.fact_id, m.remito_id_ref, m.gasto_id_ref, m.liquidacion_id, m.adelanto_id_ref) AS j) jc
      WHERE m.tenant_id=v_tenant AND m.local_id=p_local_id AND m.anulado=false
        AND m.cuenta = ANY(v_cuentas) AND m.fecha >= p_periodo_mes AND m.fecha < v_fin
    ) e
    UNION ALL
    SELECT l.monto_bruto, l.categoria FROM cashflow_lineas l JOIN cashflow_extractos ex ON ex.id=l.extracto_id
    WHERE l.tenant_id=v_tenant AND ex.local_id=p_local_id AND ex.periodo_mes=p_periodo_mes AND NOT l.es_interno
  )
  SELECT
    coalesce((SELECT SUM(-monto) FROM cat WHERE c='retiro_socio' AND monto<0),0),
    coalesce((SELECT SUM(monto)  FROM cat WHERE c='aporte_socio' AND monto>0),0),
    coalesce((SELECT SUM(-monto) FROM cat WHERE c='obra_capex' AND monto<0),0)
  INTO v_retiros, v_aportes, v_obra;

  -- Δ stock: requiere inventario valorizado (no en MVP) → 0 + flag estimado.
  v_stock := 0;

  -- Cash generado (método indirecto).
  v_cash := v_util - v_stock - v_transito + v_por_pagar - v_retiros + v_aportes - v_obra;

  RETURN jsonb_build_object(
    'periodo', p_periodo_mes, 'local_id', p_local_id,
    'devengado', jsonb_build_object(
      'ventas', v_ventas, 'cmv', v_cmv, 'gastos_fijos', v_gfijos, 'gastos_variables', v_gvar,
      'sueldos', v_sueldos, 'cargas_sociales', v_cargas, 'publicidad', v_pub, 'comisiones', v_com,
      'impuestos', v_imp, 'otros', v_otros, 'utilidad_neta', v_util),
    'puente', jsonb_build_array(
      jsonb_build_object('concepto','Ganancia devengada (EERR)', 'signo','=', 'monto', v_util),
      jsonb_build_object('concepto','− Aumento de stock', 'signo','-', 'monto', v_stock, 'estimado', true),
      jsonb_build_object('concepto','− Aumento por cobrar (en tránsito)', 'signo','-', 'monto', v_transito),
      jsonb_build_object('concepto','+ Aumento deuda proveedores (por pagar)', 'signo','+', 'monto', v_por_pagar),
      jsonb_build_object('concepto','− Retiros de socios', 'signo','-', 'monto', v_retiros),
      jsonb_build_object('concepto','+ Aportes de socios', 'signo','+', 'monto', v_aportes),
      jsonb_build_object('concepto','− Inversión / obra (CAPEX)', 'signo','-', 'monto', v_obra)
    ),
    'cash_generado', v_cash,
    'stock_estimado', true
  );
END $$;
REVOKE ALL ON FUNCTION cashflow_puente_mes(integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_puente_mes(integer, date) TO authenticated;

COMMIT;
