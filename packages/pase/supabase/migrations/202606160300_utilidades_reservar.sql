-- 202606160300_utilidades_reservar.sql
-- Apartar plata a CAJA UTILIDADES (disciplina Profit First). Reusa transferencia_cuentas.
-- NOTA: NO se pre-inserta la fila en saldos_caja. El trigger fn_trg_sync_saldos_caja
-- la crea/actualiza on-demand via ON CONFLICT (cuenta, local_id) al primer movimiento.
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_reservar(
  p_local_id integer, p_cuenta_origen text, p_monto numeric, p_fecha date, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_cached jsonb;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF COALESCE(TRIM(p_cuenta_origen),'') = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF UPPER(TRIM(p_cuenta_origen)) = 'CAJA UTILIDADES' THEN RAISE EXCEPTION 'CUENTA_ORIGEN_INVALIDA'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='utilidades_reservar' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  -- Transferencia interna operativo → CAJA UTILIDADES (el cashflow la netea).
  PERFORM transferencia_cuentas(p_local_id, p_cuenta_origen, 'CAJA UTILIDADES', p_monto, p_fecha, 'Reserva de utilidades');

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('utilidades_reservar',p_idempotency_key,v_tenant,jsonb_build_object('reservado',p_monto))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('reservado', p_monto);
END $$;
REVOKE ALL ON FUNCTION utilidades_reservar(integer,text,numeric,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_reservar(integer,text,numeric,date,text) TO authenticated;
COMMIT;
