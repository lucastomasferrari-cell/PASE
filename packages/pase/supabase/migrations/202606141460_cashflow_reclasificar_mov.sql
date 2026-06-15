-- 202606141460_cashflow_reclasificar_mov.sql
-- Fase 3.5 del módulo Cashflow: reclasificar un movimiento de EFECTIVO (override
-- en cashflow_mov_clasif), con memoria opcional. Espejo de cashflow_reclasificar
-- pero sobre movimientos. Permite retiro_socio manual (para que la caja cuadre);
-- la gestión del reparto vive en el módulo Utilidades (futuro).
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_reclasificar_mov(
  p_mov_id text,
  p_categoria text,
  p_es_interno boolean DEFAULT false,
  p_aplicar_todas boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_local integer; v_fecha date; v_detalle text;
  v_texto text; v_afectadas int := 0; v_extra int := 0;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_categoria NOT IN ('venta','comision','retencion','proveedor','sueldo','gasto',
                         'retiro_socio','aporte_socio','obra_capex','transferencia_interna','apertura_ajuste','otro') THEN
    RAISE EXCEPTION 'CATEGORIA_INVALIDA';
  END IF;

  -- Cargar el movimiento (filtro por tenant explícito: DEFINER bypassa RLS).
  SELECT local_id, fecha, detalle INTO v_local, v_fecha, v_detalle
  FROM movimientos WHERE id = p_mov_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'MOV_NO_ENCONTRADO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO';
  END IF;

  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=v_local
             AND periodo_mes=date_trunc('month', v_fecha)::date AND bloqueado) THEN
    RAISE EXCEPTION 'MES_BLOQUEADO';
  END IF;

  v_texto := fn_normalizar_texto(v_detalle);

  -- 1) Override del movimiento tocado.
  INSERT INTO cashflow_mov_clasif (tenant_id, local_id, movimiento_id, categoria, es_interno, updated_at)
  VALUES (v_tenant, v_local, p_mov_id, p_categoria, p_es_interno, NOW())
  ON CONFLICT (tenant_id, movimiento_id)
  DO UPDATE SET categoria=EXCLUDED.categoria, es_interno=EXCLUDED.es_interno, updated_at=NOW();
  v_afectadas := 1;

  IF p_aplicar_todas THEN
    -- 2a) Recordar la regla (scope 'efectivo').
    INSERT INTO cashflow_mapeo (tenant_id, texto_norm, cuenta, categoria, es_interno, updated_at)
    VALUES (v_tenant, v_texto, 'efectivo', p_categoria, p_es_interno, NOW())
    ON CONFLICT (tenant_id, texto_norm, cuenta)
    DO UPDATE SET categoria=EXCLUDED.categoria, es_interno=EXCLUDED.es_interno, updated_at=NOW();

    -- 2b) Aplicar el override a los demás movimientos de efectivo con el mismo
    --     texto que NO tengan override y no estén en mes bloqueado.
    INSERT INTO cashflow_mov_clasif (tenant_id, local_id, movimiento_id, categoria, es_interno, updated_at)
    SELECT m.tenant_id, m.local_id, m.id, p_categoria, p_es_interno, NOW()
    FROM movimientos m
    WHERE m.tenant_id = v_tenant
      AND m.anulado = false
      AND m.cuenta IN ('Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES')
      AND m.id <> p_mov_id
      AND fn_normalizar_texto(m.detalle) = v_texto
      AND NOT EXISTS (SELECT 1 FROM cashflow_mov_clasif x
                      WHERE x.tenant_id = m.tenant_id AND x.movimiento_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM cashflow_cierres cc
                      WHERE cc.tenant_id = m.tenant_id AND cc.local_id = m.local_id
                        AND cc.periodo_mes = date_trunc('month', m.fecha)::date AND cc.bloqueado)
    ON CONFLICT (tenant_id, movimiento_id) DO NOTHING;
    GET DIAGNOSTICS v_extra = ROW_COUNT;
    v_afectadas := v_afectadas + v_extra;
  END IF;

  RETURN jsonb_build_object('mov_id', p_mov_id, 'afectadas', v_afectadas);
END $$;
REVOKE ALL ON FUNCTION cashflow_reclasificar_mov(text,text,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_reclasificar_mov(text,text,boolean,boolean) TO authenticated;

COMMIT;
