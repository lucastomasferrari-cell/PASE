-- Fix bug: la RPC crear_factura_completa calculaba v_tipo con fallback
-- 'factura' pero NUNCA lo aplicaba al INSERT (jsonb_populate_record
-- usaba el JSON original sin sobrescribir). Si el caller no mandaba
-- 'tipo', el INSERT fallaba con:
--   null value in column "tipo" of relation "facturas" violates not null
--
-- Detectado 2026-05-13 con flow LectorFacturasIA (que no setea 'tipo').
-- Doble fix: el frontend ahora manda tipo='factura' explícito, y esta
-- migration arregla el RPC para que el fallback funcione (defense-in-depth
-- contra futuros callers que olviden setearlo).

CREATE OR REPLACE FUNCTION crear_factura_completa(
  p_factura         jsonb,
  p_items           jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text  DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_tenant uuid;
  v_factura_record facturas%ROWTYPE;
  v_factura_id text;
  v_local_id integer;
  v_prov_id integer;
  v_tipo text;
  v_total numeric;
  v_cached jsonb;
  v_result jsonb;
  v_items_count int := 0;
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;

  IF p_factura IS NULL OR jsonb_typeof(p_factura) <> 'object' THEN
    RAISE EXCEPTION 'FACTURA_INVALIDA';
  END IF;
  v_factura_id := p_factura->>'id';
  v_local_id := nullif(p_factura->>'local_id', '')::integer;
  v_prov_id := nullif(p_factura->>'prov_id', '')::integer;
  v_tipo := COALESCE(NULLIF(p_factura->>'tipo', ''), 'factura');
  v_total := COALESCE((p_factura->>'total')::numeric, 0);

  IF v_factura_id IS NULL OR length(trim(v_factura_id)) = 0 THEN
    RAISE EXCEPTION 'FACTURA_INVALIDA: id requerido';
  END IF;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUIRED'; END IF;
  IF v_prov_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_REQUERIDO'; END IF;

  PERFORM _validar_local_autorizado(v_local_id);

  IF v_tipo = 'nota_credito' AND v_total >= 0 THEN
    RAISE EXCEPTION 'FACTURA_INVALIDA: NC debe tener total < 0';
  END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'crear_factura_completa' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  -- FIX: agregar tipo (con fallback ya resuelto en v_tipo) y tenant_id
  -- al JSON antes del populate_record. Antes solo se sobreescribía
  -- tenant_id y tipo se ignoraba — si venía null el INSERT fallaba.
  v_factura_record := jsonb_populate_record(
    NULL::facturas,
    p_factura || jsonb_build_object(
      'tenant_id', v_tenant,
      'tipo', v_tipo
    )
  );

  IF v_factura_record.pagos IS NULL THEN
    v_factura_record.pagos := '[]'::jsonb;
  END IF;

  INSERT INTO facturas SELECT v_factura_record.*;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
    INSERT INTO factura_items
    SELECT * FROM jsonb_populate_recordset(
      NULL::factura_items,
      (
        SELECT jsonb_agg(item || jsonb_build_object('factura_id', v_factura_id, 'tenant_id', v_tenant))
        FROM jsonb_array_elements(p_items) AS item
      )
    );
    v_items_count := jsonb_array_length(p_items);
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'factura_id', v_factura_id,
    'items_insertados', v_items_count,
    'creada_por_uid', v_caller_uid
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('crear_factura_completa', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;
