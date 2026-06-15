-- 202606141700_cashflow_cerrar.sql
-- Fase 4 del módulo Cashflow (Task 8): cerrar/bloquear un mes conciliado.
-- Calcula y snapshotea los saldos finales por cuenta y deja el mes read-only.
-- SECURITY DEFINER, auth check, idempotency.
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_cerrar_mes(
  p_local_id integer,
  p_periodo_mes date,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_cached jsonb; v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_efvo numeric; v_util numeric; v_mp numeric; v_banco numeric; v_saldos jsonb;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='cashflow_cerrar_mes' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=p_local_id
             AND periodo_mes=p_periodo_mes AND bloqueado) THEN
    RAISE EXCEPTION 'MES_YA_BLOQUEADO';
  END IF;

  -- Saldos finales (acumulado a fin de mes).
  SELECT coalesce(SUM(importe) FILTER (WHERE cuenta <> 'CAJA UTILIDADES'), 0),
         coalesce(SUM(importe) FILTER (WHERE cuenta =  'CAJA UTILIDADES'), 0)
    INTO v_efvo, v_util
  FROM movimientos
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND anulado=false
    AND cuenta = ANY(ARRAY['Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES']) AND fecha < v_fin;

  SELECT coalesce(SUM(saldo_final) FILTER (WHERE cuenta='MercadoPago'), 0),
         coalesce(SUM(saldo_final) FILTER (WHERE cuenta='Banco'), 0)
    INTO v_mp, v_banco
  FROM cashflow_extractos
  WHERE tenant_id=v_tenant AND local_id=p_local_id AND periodo_mes=p_periodo_mes;

  v_saldos := jsonb_build_object('efectivo',v_efvo,'utilidades',v_util,'mercadopago',v_mp,'banco',v_banco);

  INSERT INTO cashflow_cierres (tenant_id, local_id, periodo_mes, saldos, bloqueado, bloqueado_at, bloqueado_por)
  VALUES (v_tenant, p_local_id, p_periodo_mes, v_saldos, true, NOW(), auth_usuario_id())
  ON CONFLICT (tenant_id, local_id, periodo_mes)
  DO UPDATE SET saldos=EXCLUDED.saldos, bloqueado=true, bloqueado_at=NOW(),
                bloqueado_por=auth_usuario_id(), updated_at=NOW();

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('cashflow_cerrar_mes',p_idempotency_key,v_tenant,jsonb_build_object('bloqueado',true,'saldos',v_saldos))
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('bloqueado', true, 'saldos', v_saldos);
END $$;
REVOKE ALL ON FUNCTION cashflow_cerrar_mes(integer, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_cerrar_mes(integer, date, text) TO authenticated;

COMMIT;
