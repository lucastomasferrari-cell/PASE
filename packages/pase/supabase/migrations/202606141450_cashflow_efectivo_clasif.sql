-- 202606141450_cashflow_efectivo_clasif.sql
-- Fase 3.5 del módulo Cashflow (addendum 15-jun): clasificación de los
-- movimientos de efectivo. Override manual por movimiento + categoría
-- apertura_ajuste + helper que resuelve la categoría de cashflow de un
-- movimiento de efectivo (override > tipo/documento > reglas de texto).
-- retiro_socio NUNCA se auto-asigna por texto (anti-mezcla, spec §3.1).
BEGIN;

-- 1) Override por movimiento (movimientos no puede guardar la categoría del cashflow).
CREATE TABLE IF NOT EXISTS cashflow_mov_clasif (
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  movimiento_id TEXT NOT NULL,                -- movimientos.id es TEXT
  categoria     TEXT NOT NULL,
  es_interno    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, movimiento_id)
);
CREATE INDEX IF NOT EXISTS idx_cf_movclasif_tl ON cashflow_mov_clasif(tenant_id, local_id);

ALTER TABLE cashflow_mov_clasif ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cashflow_mov_clasif_all ON cashflow_mov_clasif;
CREATE POLICY cashflow_mov_clasif_all ON cashflow_mov_clasif FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

-- 2) Categoría apertura_ajuste en la lista válida: recrear cashflow_reclasificar
--    con el CHECK ampliado (resto idéntico a 202606141400).
CREATE OR REPLACE FUNCTION cashflow_reclasificar(
  p_linea_id uuid, p_categoria text, p_es_interno boolean DEFAULT false,
  p_aplicar_todas boolean DEFAULT false, p_global boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_local integer; v_desc text; v_cuenta text; v_periodo date;
  v_texto text; v_scope text; v_afectadas int := 0; v_extra int := 0;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF p_categoria NOT IN ('venta','comision','retencion','proveedor','sueldo','gasto',
                         'retiro_socio','aporte_socio','obra_capex','transferencia_interna','apertura_ajuste','otro') THEN
    RAISE EXCEPTION 'CATEGORIA_INVALIDA';
  END IF;
  SELECT l.local_id, l.descripcion, e.cuenta, e.periodo_mes
    INTO v_local, v_desc, v_cuenta, v_periodo
  FROM cashflow_lineas l JOIN cashflow_extractos e ON e.id = l.extracto_id
  WHERE l.id = p_linea_id AND l.tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINEA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=v_local
             AND periodo_mes=v_periodo AND bloqueado) THEN RAISE EXCEPTION 'MES_BLOQUEADO'; END IF;
  v_texto := fn_normalizar_texto(v_desc);
  UPDATE cashflow_lineas SET categoria=p_categoria, es_interno=p_es_interno, confirmada=true, updated_at=NOW()
   WHERE id=p_linea_id AND tenant_id=v_tenant;
  v_afectadas := 1;
  IF p_aplicar_todas THEN
    v_scope := CASE WHEN p_global THEN '*' ELSE v_cuenta END;
    INSERT INTO cashflow_mapeo (tenant_id, texto_norm, cuenta, categoria, es_interno, updated_at)
    VALUES (v_tenant, v_texto, v_scope, p_categoria, p_es_interno, NOW())
    ON CONFLICT (tenant_id, texto_norm, cuenta)
    DO UPDATE SET categoria=EXCLUDED.categoria, es_interno=EXCLUDED.es_interno, updated_at=NOW();
    UPDATE cashflow_lineas l SET categoria=p_categoria, es_interno=p_es_interno, updated_at=NOW()
      FROM cashflow_extractos e
     WHERE l.extracto_id=e.id AND l.tenant_id=v_tenant AND l.id<>p_linea_id AND NOT l.confirmada
       AND fn_normalizar_texto(l.descripcion)=v_texto AND (p_global OR e.cuenta=v_cuenta)
       AND NOT EXISTS (SELECT 1 FROM cashflow_cierres cc WHERE cc.tenant_id=l.tenant_id
                       AND cc.local_id=l.local_id AND cc.periodo_mes=e.periodo_mes AND cc.bloqueado);
    GET DIAGNOSTICS v_extra = ROW_COUNT;
    v_afectadas := v_afectadas + v_extra;
  END IF;
  RETURN jsonb_build_object('linea_id', p_linea_id, 'afectadas', v_afectadas);
END $$;
REVOKE ALL ON FUNCTION cashflow_reclasificar(uuid,text,boolean,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_reclasificar(uuid,text,boolean,boolean,boolean) TO authenticated;

-- 3) Helper: categoría de cashflow de un movimiento de efectivo.
--    Prioridad: override manual > tipo/documento > reglas de texto (manuales).
--    NUNCA devuelve retiro_socio por texto (anti-mezcla).
CREATE OR REPLACE FUNCTION fn_cashflow_cat_efectivo(
  p_tenant uuid, p_mov_id text, p_tipo text, p_detalle text, p_importe numeric,
  p_fact_id text, p_remito_id text, p_gasto_id text, p_liq_id uuid, p_adelanto_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE v_cat text; v_ovr record; d text;
BEGIN
  -- 1) override manual
  SELECT categoria, es_interno INTO v_ovr FROM cashflow_mov_clasif
    WHERE tenant_id=p_tenant AND movimiento_id=p_mov_id;
  IF FOUND THEN RETURN jsonb_build_object('categoria',v_ovr.categoria,'es_interno',v_ovr.es_interno,'fuente','override'); END IF;
  -- 2) por tipo / documento de origen
  v_cat := CASE
    WHEN p_tipo IN ('Transferencia Entrada','Transferencia Salida') THEN 'transferencia_interna'
    WHEN p_tipo = 'Ingreso Venta' THEN 'venta'
    WHEN p_tipo = 'Pago Proveedor' OR p_fact_id IS NOT NULL OR p_remito_id IS NOT NULL THEN 'proveedor'
    WHEN p_tipo IN ('Pago Sueldo','Gasto empleado') OR p_liq_id IS NOT NULL OR p_adelanto_id IS NOT NULL THEN 'sueldo'
    WHEN p_tipo = 'Gasto impuesto' THEN 'retencion'
    WHEN p_tipo = 'Gasto retiro_socio' THEN 'retiro_socio'
    WHEN p_tipo IN ('Gasto variable','Gasto fijo') OR p_gasto_id IS NOT NULL THEN 'gasto'
    ELSE NULL END;
  IF v_cat IS NOT NULL THEN
    RETURN jsonb_build_object('categoria',v_cat,'es_interno', v_cat='transferencia_interna','fuente','tipo');
  END IF;
  -- 3) manuales sin documento → reglas de texto (NUNCA retiro_socio)
  d := fn_normalizar_texto(p_detalle);
  IF d LIKE '%saldo inicial%' OR d LIKE '%caja en 0%' OR d LIKE '%saldo caja fuerte%'
     OR d LIKE '%ajuste%' OR d LIKE '%sobrante%' OR d LIKE '%faltante%' OR d LIKE '%arqueo%' THEN
    RETURN jsonb_build_object('categoria','apertura_ajuste','es_interno',false,'fuente','texto');
  END IF;
  IF d LIKE '%retiro del local%' OR d LIKE '%caja grande%' OR d LIKE '%a caja %' OR d LIKE '%entre caja%' THEN
    RETURN jsonb_build_object('categoria','transferencia_interna','es_interno',true,'fuente','texto');
  END IF;
  IF d LIKE '%aporte%' THEN
    RETURN jsonb_build_object('categoria','aporte_socio','es_interno',false,'fuente','texto');
  END IF;
  -- default: queda 'otro' (la bandeja "Por revisar" lo levanta)
  RETURN jsonb_build_object('categoria','otro','es_interno',false,'fuente','default');
END $$;
REVOKE ALL ON FUNCTION fn_cashflow_cat_efectivo(uuid,text,text,text,numeric,text,text,text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_cashflow_cat_efectivo(uuid,text,text,text,numeric,text,text,text,uuid,uuid) TO authenticated;

COMMIT;
