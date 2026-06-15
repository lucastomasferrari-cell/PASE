-- 202606141400_cashflow_reclasificar.sql
-- Fase 3 del módulo Cashflow (Task 5): reclasificar una línea de extracto, con
-- memoria opcional. Si p_aplicar_todas, guarda la regla en cashflow_mapeo y la
-- aplica a las demás líneas NO confirmadas con el mismo texto normalizado.
-- Patrón espejo de fn_conciliar_producto (bandeja de Compras).
BEGIN;

CREATE OR REPLACE FUNCTION cashflow_reclasificar(
  p_linea_id uuid,
  p_categoria text,
  p_es_interno boolean DEFAULT false,
  p_aplicar_todas boolean DEFAULT false,
  p_global boolean DEFAULT false   -- true = regla para cualquier cuenta ('*'); false = solo la cuenta de la línea
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_local integer; v_desc text; v_cuenta text; v_periodo date;
  v_texto text; v_scope text; v_afectadas int := 0; v_extra int := 0;
BEGIN
  -- Auth check (C11).
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- Categoría válida (catálogo del spec §3.2).
  IF p_categoria NOT IN ('venta','comision','retencion','proveedor','sueldo','gasto',
                         'retiro_socio','aporte_socio','obra_capex','transferencia_interna','otro') THEN
    RAISE EXCEPTION 'CATEGORIA_INVALIDA';
  END IF;

  -- Cargar la línea (filtro por tenant explícito: DEFINER bypassa RLS).
  SELECT l.local_id, l.descripcion, e.cuenta, e.periodo_mes
    INTO v_local, v_desc, v_cuenta, v_periodo
  FROM cashflow_lineas l
  JOIN cashflow_extractos e ON e.id = l.extracto_id
  WHERE l.id = p_linea_id AND l.tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINEA_NO_ENCONTRADA'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO';
  END IF;

  -- No tocar meses bloqueados.
  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=v_local
             AND periodo_mes=v_periodo AND bloqueado) THEN
    RAISE EXCEPTION 'MES_BLOQUEADO';
  END IF;

  v_texto := fn_normalizar_texto(v_desc);

  -- 1) La línea tocada: queda confirmada (decisión humana explícita).
  UPDATE cashflow_lineas
     SET categoria = p_categoria, es_interno = p_es_interno, confirmada = true, updated_at = NOW()
   WHERE id = p_linea_id AND tenant_id = v_tenant;
  v_afectadas := 1;

  IF p_aplicar_todas THEN
    v_scope := CASE WHEN p_global THEN '*' ELSE v_cuenta END;

    -- 2a) Guardar/actualizar la regla aprendida.
    INSERT INTO cashflow_mapeo (tenant_id, texto_norm, cuenta, categoria, es_interno, updated_at)
    VALUES (v_tenant, v_texto, v_scope, p_categoria, p_es_interno, NOW())
    ON CONFLICT (tenant_id, texto_norm, cuenta)
    DO UPDATE SET categoria = EXCLUDED.categoria, es_interno = EXCLUDED.es_interno, updated_at = NOW();

    -- 2b) Aplicar a las demás líneas NO confirmadas con el mismo texto, dentro
    --     del scope de cuenta, excluyendo meses bloqueados y la línea ya tocada.
    --     (Quedan sin confirmar: una corrección futura del mismo texto las vuelve
    --     a alcanzar.)
    UPDATE cashflow_lineas l
       SET categoria = p_categoria, es_interno = p_es_interno, updated_at = NOW()
      FROM cashflow_extractos e
     WHERE l.extracto_id = e.id
       AND l.tenant_id = v_tenant
       AND l.id <> p_linea_id
       AND NOT l.confirmada
       AND fn_normalizar_texto(l.descripcion) = v_texto
       AND (p_global OR e.cuenta = v_cuenta)
       AND NOT EXISTS (SELECT 1 FROM cashflow_cierres cc
                       WHERE cc.tenant_id = l.tenant_id AND cc.local_id = l.local_id
                         AND cc.periodo_mes = e.periodo_mes AND cc.bloqueado);
    GET DIAGNOSTICS v_extra = ROW_COUNT;
    v_afectadas := v_afectadas + v_extra;
  END IF;

  RETURN jsonb_build_object('linea_id', p_linea_id, 'afectadas', v_afectadas);
END $$;
REVOKE ALL ON FUNCTION cashflow_reclasificar(uuid,text,boolean,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_reclasificar(uuid,text,boolean,boolean,boolean) TO authenticated;

COMMIT;
