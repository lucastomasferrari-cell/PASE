-- 202606110600_fix_editar_factura_conflict.sql
-- Fix bug Lucas 10-jun: "Error al guardar: Error editando factura: there
-- is no unique or exclusion constraint matching the ON CONFLICT
-- specification". La PK de idempotency_keys es (rpc_name, key, tenant_id)
-- pero la RPC editar_factura (202606110200) usaba ON CONFLICT (rpc_name,
-- key). Corrijo ambos sitios: el ON CONFLICT del INSERT + el SELECT del
-- check de duplicado (que debería filtrar por tenant_id también, defense-
-- in-depth contra colisiones cross-tenant).

CREATE OR REPLACE FUNCTION editar_factura(
  p_factura_id        TEXT,
  p_motivo            TEXT,
  p_nro               TEXT,
  p_fecha             DATE,
  p_venc              DATE,
  p_cat               TEXT,
  p_detalle           TEXT,
  p_neto              NUMERIC,
  p_iva21             NUMERIC,
  p_iva105            NUMERIC,
  p_iva27             NUMERIC,
  p_no_gravado        NUMERIC,
  p_exento            NUMERIC,
  p_iibb_caba         NUMERIC,
  p_iibb_ba           NUMERIC,
  p_iibb_otros        NUMERIC,
  p_iibb_otros_jurisdiccion TEXT,
  p_perc_iva          NUMERIC,
  p_perc_ganancias    NUMERIC,
  p_retencion_suss    NUMERIC,
  p_otros_cargos      NUMERIC,
  p_descuentos        NUMERIC,
  p_idempotency_key   TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := auth_tenant_id();
  v_fact RECORD;
  v_cached JSONB;
  v_iibb_total NUMERIC;
  v_total NUMERIC;
  v_bucket TEXT;
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'editar_factura'
        AND key = p_idempotency_key
        AND tenant_id = v_tenant;  -- defense in depth
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_fact FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fact IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fact.tenant_id <> v_tenant THEN RAISE EXCEPTION 'TENANT_MISMATCH'; END IF;
  IF v_fact.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fact.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA: no se puede editar una factura pagada — anulala y cargala de nuevo'; END IF;

  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  v_iibb_total := COALESCE(p_iibb_caba, 0) + COALESCE(p_iibb_ba, 0) + COALESCE(p_iibb_otros, 0);
  v_total := COALESCE(p_neto, 0) + COALESCE(p_no_gravado, 0) + COALESCE(p_exento, 0)
           + COALESCE(p_iva21, 0) + COALESCE(p_iva105, 0) + COALESCE(p_iva27, 0)
           + v_iibb_total
           + COALESCE(p_perc_iva, 0) + COALESCE(p_perc_ganancias, 0) + COALESCE(p_retencion_suss, 0)
           + COALESCE(p_otros_cargos, 0) - COALESCE(p_descuentos, 0);
  IF v_fact.tipo = 'nota_credito' AND v_total > 0 THEN v_total := -v_total; END IF;

  SELECT CASE c.tipo
    WHEN 'cat_compra' THEN 'cat_compra'
    WHEN 'gasto_fijo' THEN 'gasto_fijo'
    WHEN 'gasto_variable' THEN 'gasto_variable'
    WHEN 'gasto_publicidad' THEN 'gasto_publicidad'
    WHEN 'gasto_comision' THEN 'gasto_comision'
    WHEN 'gasto_impuesto' THEN 'gasto_impuesto'
    ELSE NULL END
  INTO v_bucket
  FROM config_categorias c
  WHERE c.tenant_id = v_tenant AND c.nombre = p_cat
  LIMIT 1;

  UPDATE facturas SET
    nro = p_nro,
    fecha = p_fecha,
    venc = p_venc,
    cat = p_cat,
    detalle = p_detalle,
    neto = COALESCE(p_neto, 0),
    iva21 = COALESCE(p_iva21, 0),
    iva105 = COALESCE(p_iva105, 0),
    iva27 = COALESCE(p_iva27, 0),
    no_gravado = COALESCE(p_no_gravado, 0),
    exento = COALESCE(p_exento, 0),
    iibb_caba = COALESCE(p_iibb_caba, 0),
    iibb_ba = COALESCE(p_iibb_ba, 0),
    iibb_otros = COALESCE(p_iibb_otros, 0),
    iibb_otros_jurisdiccion = NULLIF(TRIM(p_iibb_otros_jurisdiccion), ''),
    iibb = v_iibb_total,
    perc_iva = COALESCE(p_perc_iva, 0),
    perc_ganancias = COALESCE(p_perc_ganancias, 0),
    retencion_suss = COALESCE(p_retencion_suss, 0),
    otros_cargos = COALESCE(p_otros_cargos, 0),
    descuentos = COALESCE(p_descuentos, 0),
    total = v_total,
    bucket = v_bucket
  WHERE id = p_factura_id;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('editar_factura', p_idempotency_key, v_tenant,
            jsonb_build_object('ok', true, 'factura_id', p_factura_id, 'total', v_total))
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'factura_id', p_factura_id, 'total', v_total);
END;
$$;

NOTIFY pgrst, 'reload schema';
