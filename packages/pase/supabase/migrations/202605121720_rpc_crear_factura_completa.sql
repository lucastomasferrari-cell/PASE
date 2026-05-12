-- ═══════════════════════════════════════════════════════════════════════════
-- RPC crear_factura_completa: factura + items atómico.
--
-- Cumple deuda C4-F12. Antes (Compras.tsx::guardar + LectorFacturasIA::insert)
-- se hacían 2 operaciones sueltas:
--   INSERT facturas (...)
--   INSERT factura_items (...)
-- Si el INSERT de items fallaba, quedaba factura sin detalle. Si el insert
-- de factura entraba pero la red se caía antes del de items, había que
-- editar la factura para agregar el detalle manualmente.
--
-- Esta RPC hace ambos en una TX. Acepta `p_factura` como jsonb completo
-- (mapeable a la row de facturas via jsonb_populate_record) y `p_items`
-- como jsonb array. Idempotency key para anti doble-click.
--
-- El trigger trg_saldo_prov_facturas sigue cubriendo la actualización de
-- proveedores.saldo (no hay que hacerla acá manualmente).
--
-- SECURITY DEFINER + chequeo de permiso compras + tenant + local autorizado.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- ─── 1) Auth (regla C11) ─────────────────────────────────────────────────
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;

  -- ─── 2) Validar shape básico ─────────────────────────────────────────────
  IF p_factura IS NULL OR jsonb_typeof(p_factura) <> 'object' THEN
    RAISE EXCEPTION 'FACTURA_INVALIDA';
  END IF;
  v_factura_id := p_factura->>'id';
  v_local_id := nullif(p_factura->>'local_id', '')::integer;
  v_prov_id := nullif(p_factura->>'prov_id', '')::integer;
  v_tipo := COALESCE(p_factura->>'tipo', 'factura');
  v_total := COALESCE((p_factura->>'total')::numeric, 0);

  IF v_factura_id IS NULL OR length(trim(v_factura_id)) = 0 THEN
    RAISE EXCEPTION 'FACTURA_INVALIDA: id requerido';
  END IF;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUIRED'; END IF;
  IF v_prov_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_REQUERIDO'; END IF;

  -- Validar local autorizado para el caller (helper estándar, 1 arg).
  PERFORM _validar_local_autorizado(v_local_id);

  -- Validar signo de total para NCs (alineado con CHECK constraint).
  IF v_tipo = 'nota_credito' AND v_total >= 0 THEN
    RAISE EXCEPTION 'FACTURA_INVALIDA: NC debe tener total < 0';
  END IF;

  -- ─── 3) Idempotency check ────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'crear_factura_completa' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  -- ─── 4) INSERT factura ──────────────────────────────────────────────────
  -- jsonb_populate_record mapea los keys del JSON a las columnas de facturas.
  -- Keys no existentes se ignoran. tenant_id lo forzamos por seguridad
  -- (incluso si viniera distinto en el JSON, lo sobreescribimos).
  v_factura_record := jsonb_populate_record(NULL::facturas, p_factura || jsonb_build_object('tenant_id', v_tenant));

  -- Pagos defaulteamos a []. Si el cliente lo manda como string vacío, lo
  -- normalizamos.
  IF v_factura_record.pagos IS NULL THEN
    v_factura_record.pagos := '[]'::jsonb;
  END IF;

  INSERT INTO facturas SELECT v_factura_record.*;

  -- ─── 5) INSERT factura_items (si vienen) ────────────────────────────────
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

GRANT EXECUTE ON FUNCTION crear_factura_completa(jsonb, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION crear_factura_completa(jsonb, jsonb, text) FROM PUBLIC;
