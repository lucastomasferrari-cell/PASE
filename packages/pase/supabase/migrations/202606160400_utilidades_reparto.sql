-- 202606160400_utilidades_reparto.sql
-- Registrar un reparto: crea un gasto retiro_socio por socio (reusa crear_gasto, que
-- hitea EERR por tipo='retiro_socio' + el cashflow) y guarda reparto + detalle.
-- Anular: revierte esos gastos (reusa anular_gasto) + marca el reparto.
-- crear_gasto devuelve jsonb {gasto_id, mov_id, tipo} -> se extrae ->>'gasto_id'.
-- Categoria 'Retiro socio' = la canonica del catalogo (config_categorias); su grupo
-- 'Retiros Socios' no matchea grupos de gasto_, asi crear_gasto respeta tipo='retiro_socio'.
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_registrar_reparto(
  p_local_id integer, p_fecha date, p_total numeric, p_cuenta_origen text,
  p_periodo_ref date, p_nota text, p_detalle jsonb, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_cached jsonb; v_reparto_id uuid; v_ln jsonb; v_suma numeric := 0;
  v_socio record; v_gasto jsonb; v_gasto_id text; v_cuenta text;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_cuenta := COALESCE(NULLIF(TRIM(p_cuenta_origen),''),'CAJA UTILIDADES');

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='utilidades_registrar_reparto' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  IF p_detalle IS NULL OR jsonb_array_length(p_detalle) = 0 THEN RAISE EXCEPTION 'DETALLE_VACIO'; END IF;
  SELECT COALESCE(SUM((e->>'monto')::numeric),0) INTO v_suma FROM jsonb_array_elements(p_detalle) e;
  IF ABS(v_suma - p_total) > 0.01 THEN RAISE EXCEPTION 'DETALLE_NO_SUMA_TOTAL'; END IF;

  INSERT INTO utilidades_repartos (tenant_id, local_id, fecha, periodo_ref, total, cuenta_origen, nota)
  VALUES (v_tenant, p_local_id, p_fecha, p_periodo_ref, p_total, v_cuenta, p_nota)
  RETURNING id INTO v_reparto_id;

  FOR v_ln IN SELECT * FROM jsonb_array_elements(p_detalle) LOOP
    IF (v_ln->>'monto') IS NULL OR (v_ln->>'monto')::numeric <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
    SELECT id, nombre INTO v_socio FROM utilidades_socios
      WHERE id=(v_ln->>'socio_id')::uuid AND tenant_id=v_tenant AND local_id=p_local_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOCIO_NO_ENCONTRADO'; END IF;
    -- Crea el gasto retiro_socio (genera el movimiento; hitea EERR + cashflow).
    v_gasto := crear_gasto(p_fecha, p_local_id, 'Retiro socio', 'retiro_socio',
                           (v_ln->>'monto')::numeric, 'Reparto utilidades — ' || v_socio.nombre,
                           v_cuenta, NULL, NULL);
    v_gasto_id := v_gasto->>'gasto_id';
    INSERT INTO utilidades_reparto_detalle (tenant_id, reparto_id, socio_id, monto, gasto_id)
    VALUES (v_tenant, v_reparto_id, v_socio.id, (v_ln->>'monto')::numeric, v_gasto_id);
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('utilidades_registrar_reparto',p_idempotency_key,v_tenant,jsonb_build_object('reparto_id',v_reparto_id))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('reparto_id', v_reparto_id, 'total', p_total);
END $$;
REVOKE ALL ON FUNCTION utilidades_registrar_reparto(integer,date,numeric,text,date,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_registrar_reparto(integer,date,numeric,text,date,text,jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION utilidades_anular_reparto(p_reparto_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_local integer; v_det record; v_n int := 0;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT local_id INTO v_local FROM utilidades_repartos WHERE id=p_reparto_id AND tenant_id=v_tenant AND NOT anulado;
  IF v_local IS NULL THEN RAISE EXCEPTION 'REPARTO_NO_ENCONTRADO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  FOR v_det IN SELECT gasto_id FROM utilidades_reparto_detalle WHERE reparto_id=p_reparto_id AND gasto_id IS NOT NULL LOOP
    PERFORM anular_gasto(v_det.gasto_id, COALESCE(p_motivo,'Reparto anulado'));
    v_n := v_n + 1;
  END LOOP;
  UPDATE utilidades_repartos SET anulado=true, updated_at=NOW() WHERE id=p_reparto_id AND tenant_id=v_tenant;
  RETURN jsonb_build_object('anulado', true, 'gastos_revertidos', v_n);
END $$;
REVOKE ALL ON FUNCTION utilidades_anular_reparto(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_anular_reparto(uuid,text) TO authenticated;
COMMIT;
