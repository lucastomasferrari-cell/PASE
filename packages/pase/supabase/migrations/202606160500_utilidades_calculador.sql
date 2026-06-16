-- 202606160500_utilidades_calculador.sql
-- "Cuanto es seguro repartir" (read-only). Plata total (liquido operativo + reservado
-- en CAJA UTILIDADES) - obligaciones pendientes del mes (sueldos + facturas fijo) -
-- colchon (N x devengado del mes). Reusa cashflow_resumen_mes para la plata liquida.
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_cuanto_repartir(
  p_local_id integer, p_periodo_mes date, p_meses_colchon integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_mes int := EXTRACT(MONTH FROM p_periodo_mes)::int; v_anio int := EXTRACT(YEAR FROM p_periodo_mes)::int;
  v_resumen jsonb; v_plata numeric; v_reservado numeric;
  v_sueldos_deveng numeric; v_fijos_deveng numeric;
  v_sueldos_pend numeric; v_fijos_pend numeric;
  v_obligaciones numeric; v_colchon numeric; v_seguro numeric; v_ya_repartido numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  -- Plata total = liquido operativo (efvo+MP+banco) + reservado (CAJA UTILIDADES).
  v_resumen := cashflow_resumen_mes(p_local_id, p_periodo_mes);
  v_plata := (v_resumen->'posicion'->>'liquido_operativo')::numeric;
  v_reservado := (v_resumen->'saldos_finales'->>'utilidades')::numeric;
  v_plata := v_plata + v_reservado;

  -- Devengado del mes (run-rate): sueldos (liq->nov->empleado.local) + gastos fijos.
  SELECT COALESCE(SUM(liq.total_a_pagar),0) INTO v_sueldos_deveng
  FROM rrhh_liquidaciones liq JOIN rrhh_novedades nov ON nov.id=liq.novedad_id
  JOIN rrhh_empleados emp ON emp.id=nov.empleado_id
  WHERE liq.tenant_id=v_tenant AND emp.local_id=p_local_id AND nov.mes=v_mes AND nov.anio=v_anio
    AND liq.estado IN ('pendiente','pagado') AND liq.anulado=false;
  SELECT COALESCE(SUM(monto),0) INTO v_fijos_deveng FROM gastos
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha>=p_periodo_mes AND fecha<v_fin
     AND tipo='fijo' AND (estado<>'anulado' OR estado IS NULL);
  v_fijos_deveng := v_fijos_deveng + COALESCE((SELECT SUM(total) FROM facturas
     WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha>=p_periodo_mes AND fecha<v_fin
       AND bucket='gasto_fijo' AND (estado<>'anulada' OR estado IS NULL)),0);

  -- Obligaciones pendientes (lo que falta pagar): sueldos pendientes + facturas fijo pendientes.
  SELECT COALESCE(SUM(liq.total_a_pagar),0) INTO v_sueldos_pend
  FROM rrhh_liquidaciones liq JOIN rrhh_novedades nov ON nov.id=liq.novedad_id
  JOIN rrhh_empleados emp ON emp.id=nov.empleado_id
  WHERE liq.tenant_id=v_tenant AND emp.local_id=p_local_id AND nov.mes=v_mes AND nov.anio=v_anio
    AND liq.estado='pendiente' AND liq.anulado=false;
  SELECT COALESCE(SUM(total),0) INTO v_fijos_pend FROM facturas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha>=p_periodo_mes AND fecha<v_fin
     AND bucket='gasto_fijo' AND estado IN ('pendiente','revision');

  v_obligaciones := v_sueldos_pend + v_fijos_pend;
  v_colchon := GREATEST(p_meses_colchon,0) * (v_sueldos_deveng + v_fijos_deveng);
  v_seguro := v_plata - v_obligaciones - v_colchon;

  SELECT COALESCE(SUM(total),0) INTO v_ya_repartido FROM utilidades_repartos
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND NOT anulado
     AND fecha>=p_periodo_mes AND fecha<v_fin;

  RETURN jsonb_build_object(
    'plata_total', v_plata, 'reservado', v_reservado,
    'obligaciones_pendientes', v_obligaciones,
    'colchon', v_colchon, 'meses_colchon', p_meses_colchon,
    'seguro_repartir', v_seguro,
    'ya_repartido_mes', v_ya_repartido,
    'sobre_distribuido', v_ya_repartido > GREATEST(v_seguro,0)
  );
END $$;
REVOKE ALL ON FUNCTION utilidades_cuanto_repartir(integer,date,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_cuanto_repartir(integer,date,integer) TO authenticated;
COMMIT;
