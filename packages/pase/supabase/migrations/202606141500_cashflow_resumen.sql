-- 202606141500_cashflow_resumen.sql
-- Fase 4 del módulo Cashflow (Task 6): resumen mensual consolidado.
-- Efectivo de movimientos (categorizado vía fn_cashflow_cat_efectivo, hereda del
-- documento), MP/banco del extracto (cashflow_lineas). Excluye transferencia_interna
-- y apertura_ajuste del operativo; separa retiro_socio/aporte_socio. Verifica vs
-- el saldo de cierre del extracto. Read-only, SECURITY DEFINER, auth check.
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_resumen_mes(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid;
  v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_cuentas text[] := ARRAY['Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES'];
  v_ingresos jsonb; v_egresos jsonb;
  v_retiros numeric := 0; v_aportes numeric := 0; v_por_revisar int := 0;
  v_efvo_ini numeric := 0; v_efvo_mov numeric := 0;
  v_reservado_ini numeric := 0; v_reservado_mov numeric := 0;
  v_mp_ini numeric := 0; v_mp_fin numeric := 0; v_banco_ini numeric := 0; v_banco_fin numeric := 0;
  v_vta_no_efvo numeric := 0; v_acreditado numeric := 0;
  v_extractos jsonb; v_bloqueado boolean := false;
  v_efvo_fin numeric; v_reservado_fin numeric; v_liquido numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  -- Conjunto categorizado (efectivo + extracto) del mes → ingresos/egresos/retiros/aportes/por_revisar.
  WITH cat AS (
    SELECT e.importe AS monto, e.c, e.interno, 'efectivo'::text AS origen
    FROM (
      SELECT m.importe, jc.j->>'categoria' AS c, (jc.j->>'es_interno')::boolean AS interno
      FROM movimientos m
      CROSS JOIN LATERAL (SELECT fn_cashflow_cat_efectivo(
        v_tenant, m.id, m.tipo, m.detalle, m.importe,
        m.fact_id, m.remito_id_ref, m.gasto_id_ref, m.liquidacion_id, m.adelanto_id_ref) AS j) jc
      WHERE m.tenant_id=v_tenant AND m.local_id=p_local_id AND m.anulado=false
        AND m.cuenta = ANY(v_cuentas) AND m.fecha >= p_periodo_mes AND m.fecha < v_fin
    ) e
    UNION ALL
    SELECT l.monto_bruto, l.categoria, l.es_interno, 'extracto'
    FROM cashflow_lineas l JOIN cashflow_extractos ex ON ex.id = l.extracto_id
    WHERE l.tenant_id=v_tenant AND ex.local_id=p_local_id AND ex.periodo_mes=p_periodo_mes
  ),
  oper AS (
    SELECT c, monto FROM cat
    WHERE NOT interno AND c NOT IN ('transferencia_interna','apertura_ajuste','retiro_socio','aporte_socio')
  )
  SELECT
    coalesce((SELECT jsonb_agg(jsonb_build_object('categoria',categoria,'total',total) ORDER BY total DESC)
              FROM (SELECT c AS categoria, SUM(monto) total FROM oper WHERE monto>0 GROUP BY c) a), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object('categoria',categoria,'total',total) ORDER BY total DESC)
              FROM (SELECT c AS categoria, SUM(-monto) total FROM oper WHERE monto<0 GROUP BY c) a), '[]'::jsonb),
    coalesce((SELECT SUM(-monto) FROM cat WHERE c='retiro_socio' AND monto<0), 0),
    coalesce((SELECT SUM(monto)  FROM cat WHERE c='aporte_socio' AND monto>0), 0),
    coalesce((SELECT count(*)::int FROM cat WHERE origen='efectivo' AND c='otro'), 0)
  INTO v_ingresos, v_egresos, v_retiros, v_aportes, v_por_revisar;

  -- Saldos de efectivo (operativo = Chica/Mayor/Efectivo; reservado = CAJA UTILIDADES).
  SELECT
    coalesce(SUM(importe) FILTER (WHERE cuenta <> 'CAJA UTILIDADES' AND fecha <  p_periodo_mes), 0),
    coalesce(SUM(importe) FILTER (WHERE cuenta <> 'CAJA UTILIDADES' AND fecha >= p_periodo_mes AND fecha < v_fin), 0),
    coalesce(SUM(importe) FILTER (WHERE cuenta =  'CAJA UTILIDADES' AND fecha <  p_periodo_mes), 0),
    coalesce(SUM(importe) FILTER (WHERE cuenta =  'CAJA UTILIDADES' AND fecha >= p_periodo_mes AND fecha < v_fin), 0)
  INTO v_efvo_ini, v_efvo_mov, v_reservado_ini, v_reservado_mov
  FROM movimientos
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND anulado=false AND cuenta = ANY(v_cuentas);

  -- Saldos MP/Banco del extracto.
  SELECT
    coalesce(SUM(saldo_inicial) FILTER (WHERE cuenta='MercadoPago'), 0),
    coalesce(SUM(saldo_final)   FILTER (WHERE cuenta='MercadoPago'), 0),
    coalesce(SUM(saldo_inicial) FILTER (WHERE cuenta='Banco'), 0),
    coalesce(SUM(saldo_final)   FILTER (WHERE cuenta='Banco'), 0)
  INTO v_mp_ini, v_mp_fin, v_banco_ini, v_banco_fin
  FROM cashflow_extractos
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND periodo_mes=p_periodo_mes;

  -- En tránsito (float): ventas no-efectivo del mes − liquidaciones de venta ya acreditadas.
  SELECT coalesce(SUM(monto),0) INTO v_vta_no_efvo FROM ventas
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha >= p_periodo_mes AND fecha < v_fin
    AND upper(medio) <> 'EFECTIVO';
  SELECT coalesce(SUM(l.monto_bruto),0) INTO v_acreditado
  FROM cashflow_lineas l JOIN cashflow_extractos ex ON ex.id = l.extracto_id
  WHERE l.tenant_id=v_tenant AND ex.local_id=p_local_id AND ex.periodo_mes=p_periodo_mes
    AND l.categoria='venta' AND NOT l.es_interno;

  -- Verificación por extracto (saldo_inicial + Σ líneas = saldo_final declarado).
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'cuenta', ex.cuenta, 'saldo_inicial', ex.saldo_inicial, 'saldo_final_real', ex.saldo_final,
    'saldo_final_calc', ex.saldo_inicial + s.suma,
    'diferencia', round((ex.saldo_inicial + s.suma) - ex.saldo_final, 2),
    'cuadra', abs((ex.saldo_inicial + s.suma) - ex.saldo_final) < 0.01
  )), '[]'::jsonb) INTO v_extractos
  FROM cashflow_extractos ex
  CROSS JOIN LATERAL (SELECT coalesce(SUM(monto_bruto),0) suma FROM cashflow_lineas l WHERE l.extracto_id=ex.id) s
  WHERE ex.tenant_id=v_tenant AND ex.local_id=p_local_id AND ex.periodo_mes=p_periodo_mes;

  SELECT EXISTS(SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=p_local_id
               AND periodo_mes=p_periodo_mes AND bloqueado) INTO v_bloqueado;

  v_efvo_fin := v_efvo_ini + v_efvo_mov;
  v_reservado_fin := v_reservado_ini + v_reservado_mov;
  v_liquido := v_efvo_fin + v_mp_fin + v_banco_fin;

  RETURN jsonb_build_object(
    'periodo', p_periodo_mes, 'local_id', p_local_id,
    'saldos_iniciales', jsonb_build_object('efectivo', v_efvo_ini, 'mercadopago', v_mp_ini, 'banco', v_banco_ini, 'utilidades', v_reservado_ini),
    'saldos_finales',   jsonb_build_object('efectivo', v_efvo_fin, 'mercadopago', v_mp_fin, 'banco', v_banco_fin, 'utilidades', v_reservado_fin),
    'ingresos', v_ingresos, 'egresos', v_egresos,
    'retiros_total', v_retiros, 'aportes_total', v_aportes,
    'en_transito', jsonb_build_object('bruto', v_vta_no_efvo, 'acreditado', v_acreditado, 'neto', v_vta_no_efvo - v_acreditado),
    'posicion', jsonb_build_object('liquido_operativo', v_liquido, 'reservado', v_reservado_fin, 'en_transito', v_vta_no_efvo - v_acreditado),
    'extractos', v_extractos,
    'por_revisar', v_por_revisar,
    'bloqueado', v_bloqueado
  );
END $$;
REVOKE ALL ON FUNCTION cashflow_resumen_mes(integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_resumen_mes(integer, date) TO authenticated;

COMMIT;
