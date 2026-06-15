-- 202606141300_cashflow_rpcs_upload.sql
-- Fase 3 del módulo Cashflow (Task 4): subir un extracto MP/Banco y
-- auto-clasificar cada línea por memoria aprendida (cashflow_mapeo) y, en su
-- defecto, por reglas default. NO clasifica retiro_socio por nombre (queda
-- 'otro' hasta confirmación humana — regla anti-mezcla del spec §3.1).
BEGIN;

-- Reglas default de clasificación por texto (fallback si no hay mapeo aprendido).
-- INVOKER (helper puro, sin acceso a tablas): no requiere auth check.
CREATE OR REPLACE FUNCTION fn_cashflow_clasificar_default(p_desc text, p_monto numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE d text := fn_normalizar_texto(p_desc);
BEGIN
  IF d IS NULL OR d = '' THEN
    RETURN jsonb_build_object('categoria', CASE WHEN COALESCE(p_monto,0) >= 0 THEN 'otro' ELSE 'proveedor' END, 'es_interno', false);
  END IF;
  IF d LIKE '%liquidacion%' OR d LIKE '%cupones prisma%' OR d LIKE '%prisma%' THEN
    RETURN jsonb_build_object('categoria','venta','es_interno',false); END IF;
  IF d LIKE '%comision%' OR d LIKE '%fee%' THEN
    RETURN jsonb_build_object('categoria','comision','es_interno',false); END IF;
  IF d LIKE '%ley nro 25%' OR d LIKE '%impuesto%' OR d LIKE '%retencion%' OR d LIKE '%iva%' OR d LIKE '%sicore%' THEN
    RETURN jsonb_build_object('categoria','retencion','es_interno',false); END IF;
  IF d LIKE '%alivio%' OR d LIKE '%transferencia interna%' OR d LIKE '%entre cuentas%' THEN
    RETURN jsonb_build_object('categoria','transferencia_interna','es_interno',true); END IF;
  IF d LIKE '%pago de servicio%' OR d LIKE '%edenor%' OR d LIKE '%metrogas%' OR d LIKE '%aysa%' OR d LIKE '%edesur%' THEN
    RETURN jsonb_build_object('categoria','gasto','es_interno',false); END IF;
  -- IMPORTANTE: NO clasificar retiro_socio por nombre. Queda 'otro'/'proveedor'
  -- hasta confirmación humana explícita.
  RETURN jsonb_build_object('categoria', CASE WHEN p_monto >= 0 THEN 'otro' ELSE 'proveedor' END, 'es_interno', false);
END $$;
REVOKE ALL ON FUNCTION fn_cashflow_clasificar_default(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_cashflow_clasificar_default(text, numeric) TO authenticated;

-- Sube un extracto: upsert de cashflow_extractos + inserta líneas, auto-clasificando
-- por mapeo aprendido (prioridad: cuenta específica > '*') y luego por reglas default.
CREATE OR REPLACE FUNCTION cashflow_subir_extracto(
  p_local_id integer,
  p_cuenta text,
  p_periodo_mes date,
  p_saldo_inicial numeric,
  p_saldo_final numeric,
  p_archivo_nombre text,
  p_lineas jsonb,                 -- [{fecha, descripcion, monto_bruto, comision, retencion}]
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_cached jsonb; v_ext_id uuid; v_ln jsonb;
  v_texto text; v_cat text; v_int boolean; v_def jsonb; v_n int := 0;
  v_map_cat text; v_map_int boolean;
BEGIN
  -- Auth check (C11).
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF p_cuenta NOT IN ('MercadoPago','Banco') THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  -- Idempotency (C1).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='cashflow_subir_extracto' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  -- No permitir recargar si el mes está bloqueado.
  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=p_local_id
             AND periodo_mes=p_periodo_mes AND bloqueado) THEN
    RAISE EXCEPTION 'MES_BLOQUEADO';
  END IF;

  -- Upsert del extracto (reemplaza si ya existía para ese mes/cuenta; CASCADE borra
  -- las líneas viejas).
  DELETE FROM cashflow_extractos WHERE tenant_id=v_tenant AND local_id=p_local_id
    AND cuenta=p_cuenta AND periodo_mes=p_periodo_mes;
  INSERT INTO cashflow_extractos (tenant_id, local_id, cuenta, periodo_mes, saldo_inicial, saldo_final, archivo_nombre)
  VALUES (v_tenant, p_local_id, p_cuenta, p_periodo_mes, COALESCE(p_saldo_inicial,0), COALESCE(p_saldo_final,0), p_archivo_nombre)
  RETURNING id INTO v_ext_id;

  FOR v_ln IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_texto := fn_normalizar_texto(v_ln->>'descripcion');
    v_cat := NULL; v_int := false;
    -- 1) mapeo aprendido (cuenta específica gana sobre '*').
    SELECT categoria, es_interno INTO v_map_cat, v_map_int
      FROM cashflow_mapeo
      WHERE tenant_id=v_tenant AND texto_norm=v_texto AND cuenta IN (p_cuenta,'*')
      ORDER BY (cuenta = p_cuenta) DESC LIMIT 1;
    IF FOUND THEN
      v_cat := v_map_cat; v_int := v_map_int;
    ELSE
      v_def := fn_cashflow_clasificar_default(v_ln->>'descripcion', COALESCE((v_ln->>'monto_bruto')::numeric,0));
      v_cat := v_def->>'categoria'; v_int := (v_def->>'es_interno')::boolean;
    END IF;
    INSERT INTO cashflow_lineas (tenant_id, local_id, extracto_id, fecha, descripcion, monto_bruto, comision, retencion, categoria, es_interno)
    VALUES (v_tenant, p_local_id, v_ext_id, (v_ln->>'fecha')::date, COALESCE(v_ln->>'descripcion',''),
            COALESCE((v_ln->>'monto_bruto')::numeric,0), COALESCE((v_ln->>'comision')::numeric,0),
            COALESCE((v_ln->>'retencion')::numeric,0), v_cat, v_int);
    v_n := v_n + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('cashflow_subir_extracto',p_idempotency_key,v_tenant,
            jsonb_build_object('extracto_id',v_ext_id,'lineas',v_n))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('extracto_id', v_ext_id, 'lineas', v_n);
END $$;
REVOKE ALL ON FUNCTION cashflow_subir_extracto(integer,text,date,numeric,numeric,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_subir_extracto(integer,text,date,numeric,numeric,text,jsonb,text) TO authenticated;

COMMIT;
