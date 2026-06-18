-- 202606160700_periodos_rpcs.sql
BEGIN;
CREATE OR REPLACE FUNCTION cerrar_periodo(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_mes date := date_trunc('month', p_periodo_mes)::date;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  INSERT INTO periodos_cerrados (tenant_id, local_id, periodo_mes, cerrado_por)
  VALUES (v_tenant, p_local_id, v_mes, auth_usuario_id())
  ON CONFLICT (tenant_id, local_id, periodo_mes) DO NOTHING;
  RETURN jsonb_build_object('cerrado', true, 'local_id', p_local_id, 'periodo_mes', v_mes);
END $$;
REVOKE ALL ON FUNCTION cerrar_periodo(integer,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cerrar_periodo(integer,date) TO authenticated;

CREATE OR REPLACE FUNCTION reabrir_periodo(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_mes date := date_trunc('month', p_periodo_mes)::date; v_n int;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;
  DELETE FROM periodos_cerrados
   WHERE tenant_id = v_tenant AND local_id = p_local_id AND periodo_mes = v_mes;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM _auditar('periodos_cerrados', 'REABRIR', jsonb_build_object(
    'local_id', p_local_id, 'periodo_mes', v_mes, 'usuario_id', auth_usuario_id()), v_tenant);
  RETURN jsonb_build_object('reabierto', true, 'local_id', p_local_id, 'periodo_mes', v_mes, 'borradas', v_n);
END $$;
REVOKE ALL ON FUNCTION reabrir_periodo(integer,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reabrir_periodo(integer,date) TO authenticated;
COMMIT;
