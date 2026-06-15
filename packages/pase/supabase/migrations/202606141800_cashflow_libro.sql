-- 202606141800_cashflow_libro.sql
-- Fase 4 del módulo Cashflow (Task 8.5): libro contable / línea de tiempo.
-- Filas cronológicas con Debe/Haber/Saldo corrido, por cuenta o consolidado
-- (efectivo). Read-only, SECURITY DEFINER, auth check.
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_libro_mes(p_local_id integer, p_periodo_mes date, p_cuenta text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid;
  v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_cuentas text[] := ARRAY['Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES'];
  v_saldo_ini numeric := 0; v_filas jsonb := '[]'::jsonb; v_saldo_fin numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  IF p_cuenta IN ('MercadoPago','Banco') THEN
    -- Extracto: saldo corrido desde el saldo_inicial declarado.
    SELECT coalesce(SUM(saldo_inicial),0) INTO v_saldo_ini FROM cashflow_extractos
      WHERE tenant_id=v_tenant AND local_id=p_local_id AND periodo_mes=p_periodo_mes AND cuenta=p_cuenta;
    SELECT coalesce(jsonb_agg(f ORDER BY ord), '[]'::jsonb) INTO v_filas FROM (
      SELECT jsonb_build_object(
               'fecha', l.fecha, 'concepto', l.descripcion, 'categoria', l.categoria,
               'debe',  CASE WHEN l.monto_bruto < 0 THEN -l.monto_bruto ELSE 0 END,
               'haber', CASE WHEN l.monto_bruto > 0 THEN  l.monto_bruto ELSE 0 END,
               'saldo', v_saldo_ini + SUM(l.monto_bruto) OVER (ORDER BY l.fecha, l.created_at, l.id),
               'ref_id', l.id::text) AS f,
             row_number() OVER (ORDER BY l.fecha, l.created_at, l.id) AS ord
      FROM cashflow_lineas l JOIN cashflow_extractos e ON e.id = l.extracto_id
      WHERE l.tenant_id=v_tenant AND e.local_id=p_local_id AND e.periodo_mes=p_periodo_mes AND e.cuenta=p_cuenta
    ) z;
  ELSE
    -- Efectivo: cuenta específica o consolidado (p_cuenta NULL). Saldo corrido
    -- desde el acumulado de la(s) cuenta(s) antes del mes.
    SELECT coalesce(SUM(importe),0) INTO v_saldo_ini FROM movimientos
      WHERE tenant_id=v_tenant AND local_id=p_local_id AND anulado=false
        AND cuenta = ANY(v_cuentas) AND (p_cuenta IS NULL OR cuenta=p_cuenta) AND fecha < p_periodo_mes;
    SELECT coalesce(jsonb_agg(f ORDER BY ord), '[]'::jsonb) INTO v_filas FROM (
      SELECT jsonb_build_object(
               'fecha', m.fecha, 'concepto', m.detalle, 'categoria', jc.j->>'categoria',
               'debe',  CASE WHEN m.importe < 0 THEN -m.importe ELSE 0 END,
               'haber', CASE WHEN m.importe > 0 THEN  m.importe ELSE 0 END,
               'saldo', v_saldo_ini + SUM(m.importe) OVER (ORDER BY m.fecha, m.created_at, m.id),
               'ref_id', m.id) AS f,
             row_number() OVER (ORDER BY m.fecha, m.created_at, m.id) AS ord
      FROM movimientos m
      CROSS JOIN LATERAL (SELECT fn_cashflow_cat_efectivo(
        v_tenant, m.id, m.tipo, m.detalle, m.importe,
        m.fact_id, m.remito_id_ref, m.gasto_id_ref, m.liquidacion_id, m.adelanto_id_ref) AS j) jc
      WHERE m.tenant_id=v_tenant AND m.local_id=p_local_id AND m.anulado=false
        AND m.cuenta = ANY(v_cuentas) AND (p_cuenta IS NULL OR m.cuenta=p_cuenta)
        AND m.fecha >= p_periodo_mes AND m.fecha < v_fin
    ) z;
  END IF;

  v_saldo_fin := v_saldo_ini + coalesce(
    (SELECT SUM((f->>'haber')::numeric - (f->>'debe')::numeric) FROM jsonb_array_elements(v_filas) f), 0);

  RETURN jsonb_build_object(
    'cuenta', coalesce(p_cuenta, 'efectivo'),
    'saldo_inicial', v_saldo_ini, 'filas', v_filas, 'saldo_final', v_saldo_fin);
END $$;
REVOKE ALL ON FUNCTION cashflow_libro_mes(integer, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_libro_mes(integer, date, text) TO authenticated;

COMMIT;
