-- 202607120100_cashflow_pyl.sql
-- Módulo Cashflow: P&L "Ganancia real vs teórica".
-- Dos columnas, mismas líneas del EERR:
--   DEVENGADO (teórico): réplica exacta del EERR/puente, por fecha del documento.
--   PERCIBIDO (real):    ventas cobradas + egresos por FECHA DE PAGO, heredando la
--                        categoría del documento que paga cada movimiento.
-- Read-only, SECURITY DEFINER, auth check. No mueve plata.
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_pyl_mes(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid;
  v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_mes int := EXTRACT(MONTH FROM p_periodo_mes)::int;
  v_anio int := EXTRACT(YEAR FROM p_periodo_mes)::int;
  v_cuentas text[] := ARRAY['Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES'];
  -- devengado
  d_ventas numeric; d_cmv numeric; d_gfijos numeric; d_gvar numeric; d_cargas numeric;
  d_pub numeric; d_com numeric; d_imp numeric; d_otros numeric; d_sueldos numeric; d_util numeric;
  -- percibido
  p_ventas numeric; p_cmv numeric := 0; p_gfijos numeric := 0; p_gvar numeric := 0; p_cargas numeric := 0;
  p_pub numeric := 0; p_com numeric := 0; p_imp numeric := 0; p_otros numeric := 0; p_sueldos numeric := 0; p_util numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  -- ===== DEVENGADO (réplica EERR/puente, por fecha del documento) =====
  SELECT coalesce(SUM(monto),0) INTO d_ventas FROM ventas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin;

  SELECT coalesce(SUM(total),0) INTO d_cmv FROM facturas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
     AND (bucket IS NULL OR bucket='cat_compra') AND (estado <> 'anulada' OR estado IS NULL);

  SELECT
    coalesce(SUM(monto) FILTER (WHERE tipo='fijo' AND coalesce(categoria,'')<>'CARGAS SOCIALES'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='variable'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='fijo' AND categoria='CARGAS SOCIALES'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='publicidad'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='comision'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo='impuesto'),0),
    coalesce(SUM(monto) FILTER (WHERE tipo NOT IN ('fijo','variable','publicidad','comision','impuesto','retiro_socio','empleado')),0)
  INTO d_gfijos, d_gvar, d_cargas, d_pub, d_com, d_imp, d_otros
  FROM gastos
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
    AND (estado <> 'anulado' OR estado IS NULL);

  SELECT
    d_gfijos + coalesce(SUM(total) FILTER (WHERE bucket='gasto_fijo'),0),
    d_gvar   + coalesce(SUM(total) FILTER (WHERE bucket='gasto_variable'),0),
    d_pub    + coalesce(SUM(total) FILTER (WHERE bucket='gasto_publicidad'),0),
    d_com    + coalesce(SUM(total) FILTER (WHERE bucket='gasto_comision'),0),
    d_imp    + coalesce(SUM(total) FILTER (WHERE bucket='gasto_impuesto'),0)
  INTO d_gfijos, d_gvar, d_pub, d_com, d_imp
  FROM facturas
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
    AND (estado <> 'anulada' OR estado IS NULL);

  SELECT coalesce(SUM(liq.total_a_pagar),0) INTO d_sueldos
  FROM rrhh_liquidaciones liq
  JOIN rrhh_novedades nov ON nov.id = liq.novedad_id
  JOIN rrhh_empleados emp ON emp.id = nov.empleado_id
  WHERE liq.tenant_id=v_tenant AND emp.local_id=p_local_id
    AND nov.mes=v_mes AND nov.anio=v_anio
    AND liq.estado IN ('pendiente','pagado') AND liq.anulado=false;
  d_sueldos := d_sueldos + (SELECT coalesce(SUM(monto),0) FROM gastos
      WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
        AND tipo='empleado' AND (estado <> 'anulado' OR estado IS NULL));

  d_util := d_ventas - d_cmv - d_gfijos - d_gvar - d_sueldos - d_cargas - d_pub - d_com - d_imp - d_otros;

  -- ===== PERCIBIDO (real, por fecha de pago) =====
  -- Ventas cobradas: efectivo categorizado 'venta' + liquidaciones del extracto.
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
  SELECT coalesce(SUM(monto) FILTER (WHERE c='venta' AND monto>0),0) INTO p_ventas FROM cat;

  -- Egresos pagados: cada movimiento que paga un documento, por la categoría del documento.
  SELECT
    coalesce(SUM(a) FILTER (WHERE linea='cmv'),0),
    coalesce(SUM(a) FILTER (WHERE linea='fijos'),0),
    coalesce(SUM(a) FILTER (WHERE linea='var'),0),
    coalesce(SUM(a) FILTER (WHERE linea='cargas'),0),
    coalesce(SUM(a) FILTER (WHERE linea='pub'),0),
    coalesce(SUM(a) FILTER (WHERE linea='com'),0),
    coalesce(SUM(a) FILTER (WHERE linea='imp'),0),
    coalesce(SUM(a) FILTER (WHERE linea='sueldos'),0),
    coalesce(SUM(a) FILTER (WHERE linea='otros'),0)
  INTO p_cmv, p_gfijos, p_gvar, p_cargas, p_pub, p_com, p_imp, p_sueldos, p_otros
  FROM (
    SELECT abs(m.importe) AS a,
      CASE
        WHEN m.liquidacion_id IS NOT NULL THEN 'sueldos'
        WHEN m.fact_id IS NOT NULL THEN
          CASE WHEN coalesce(fa.bucket,'') IN ('','cat_compra') THEN 'cmv'
               WHEN fa.bucket='gasto_fijo' THEN 'fijos'
               WHEN fa.bucket='gasto_variable' THEN 'var'
               WHEN fa.bucket='gasto_publicidad' THEN 'pub'
               WHEN fa.bucket='gasto_comision' THEN 'com'
               WHEN fa.bucket='gasto_impuesto' THEN 'imp'
               ELSE 'otros' END
        WHEN m.gasto_id_ref IS NOT NULL THEN
          CASE WHEN ga.categoria='CARGAS SOCIALES' THEN 'cargas'
               WHEN ga.tipo='fijo' THEN 'fijos'
               WHEN ga.tipo='variable' THEN 'var'
               WHEN ga.tipo='publicidad' THEN 'pub'
               WHEN ga.tipo='comision' THEN 'com'
               WHEN ga.tipo='impuesto' THEN 'imp'
               WHEN ga.tipo='empleado' THEN 'sueldos'
               ELSE 'otros' END
        ELSE 'otros' END AS linea
    FROM movimientos m
    LEFT JOIN facturas fa ON fa.id = m.fact_id
    LEFT JOIN gastos ga ON ga.id = m.gasto_id_ref
    WHERE m.tenant_id=v_tenant AND m.local_id=p_local_id AND m.anulado=false
      AND m.fecha >= p_periodo_mes AND m.fecha < v_fin AND m.importe < 0
      AND (m.fact_id IS NOT NULL OR m.gasto_id_ref IS NOT NULL OR m.liquidacion_id IS NOT NULL)
  ) x;

  p_util := p_ventas - p_cmv - p_gfijos - p_gvar - p_sueldos - p_cargas - p_pub - p_com - p_imp - p_otros;

  RETURN jsonb_build_object(
    'periodo', p_periodo_mes, 'local_id', p_local_id,
    'devengado', jsonb_build_object(
      'ventas', d_ventas, 'cmv', d_cmv, 'gastos_fijos', d_gfijos, 'gastos_variables', d_gvar,
      'sueldos', d_sueldos, 'cargas_sociales', d_cargas, 'publicidad', d_pub, 'comisiones', d_com,
      'impuestos', d_imp, 'otros', d_otros, 'utilidad', d_util),
    'percibido', jsonb_build_object(
      'ventas', p_ventas, 'cmv', p_cmv, 'gastos_fijos', p_gfijos, 'gastos_variables', p_gvar,
      'sueldos', p_sueldos, 'cargas_sociales', p_cargas, 'publicidad', p_pub, 'comisiones', p_com,
      'impuestos', p_imp, 'otros', p_otros, 'utilidad', p_util)
  );
END $$;
REVOKE ALL ON FUNCTION cashflow_pyl_mes(integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_pyl_mes(integer, date) TO authenticated;

COMMIT;
