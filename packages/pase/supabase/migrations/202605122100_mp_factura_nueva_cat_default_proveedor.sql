-- ═══════════════════════════════════════════════════════════════════════════
-- fn_conciliar_mp_con_factura_nueva: derivar `cat` del proveedor por default.
--
-- Bug reportado por Lucas 2026-05-12: el form "Crear factura nueva" desde
-- Conciliación MP tenía un selector de categoría redundante — la categoría
-- siempre debería ser la del proveedor (proveedores.cat), no algo que el
-- operador elija a mano. Removido el field del frontend; esta migration
-- actualiza la RPC para que, si no recibe `cat`, lo derive del proveedor.
--
-- Fallback chain (en orden):
--   1. cat pasada explícitamente en p_factura_data (si la UI la mandara)
--   2. proveedores.cat del prov_id elegido
--   3. 'Conciliación MP' (literal, para no romper si el proveedor tampoco la
--      tiene seteada)
--
-- El resto de la lógica queda idéntica a 202605130000_facturas_bucket.sql.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_factura_nueva(
  p_mp_mov_id     text,
  p_factura_data  jsonb       -- { prov_id (int), nro, fecha?, cat?, detalle? }
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp           RECORD;
  v_usuario_id   integer;
  v_factura_id   text;
  v_mov_id       text;
  v_monto_abs    numeric;
  v_prov_id      integer;
  v_nro          text;
  v_fecha        date;
  v_cat          text;
  v_cat_form     text;
  v_prov_cat     text;
  v_detalle      text;
  v_prov_existe  boolean;
  v_bucket       text;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_prov_id := (p_factura_data->>'prov_id')::integer;
  IF v_prov_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_REQUERIDO'; END IF;
  v_nro := nullif(trim(p_factura_data->>'nro'), '');
  IF v_nro IS NULL THEN RAISE EXCEPTION 'NRO_REQUERIDO'; END IF;
  v_cat_form := nullif(trim(p_factura_data->>'cat'), '');
  v_detalle  := COALESCE(p_factura_data->>'detalle', '');

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  v_fecha := COALESCE(
    nullif(p_factura_data->>'fecha', '')::date,
    (v_mp.fecha)::date,
    current_date
  );

  -- Validar proveedor + lookup de su cat default (para usarla si la UI no
  -- mandó una explícita).
  SELECT cat INTO v_prov_cat FROM proveedores
   WHERE id = v_prov_id AND tenant_id = v_mp.tenant_id;
  v_prov_existe := FOUND;
  IF NOT v_prov_existe THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  -- Fallback chain: form > proveedor > literal.
  v_cat := COALESCE(v_cat_form, nullif(trim(v_prov_cat), ''), 'Conciliación MP');

  -- Lookup del bucket vía config_categorias por nombre. Si la cat no está en
  -- el catálogo, bucket queda NULL (mismo comportamiento que facturas legacy:
  -- caen en CMV en los reportes).
  SELECT tipo INTO v_bucket
  FROM config_categorias
  WHERE nombre = v_cat AND tenant_id = v_mp.tenant_id AND activo = true
  LIMIT 1;

  v_factura_id := _gen_id('FAC');
  INSERT INTO facturas (
    id, prov_id, local_id, nro, fecha, venc, neto, iva21, iva105, iibb,
    total, cat, estado, detalle, pagos, tipo, perc_iva, otros_cargos, descuentos,
    tenant_id, bucket
  ) VALUES (
    v_factura_id, v_prov_id, v_mp.local_id, v_nro, v_fecha, NULL,
    v_monto_abs, 0, 0, 0,
    v_monto_abs, v_cat, 'pagada',
    COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
    jsonb_build_array(jsonb_build_object('fecha', v_fecha, 'monto', v_monto_abs, 'cuenta', 'MercadoPago')),
    'factura', 0, 0, 0,
    v_mp.tenant_id, v_bucket
  );

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
    VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Factura', v_cat,
            -v_monto_abs, COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
            v_mp.local_id, v_mp.tenant_id, v_factura_id);

  PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_monto_abs);

  UPDATE mp_movimientos
     SET justificativo_tipo = 'factura',
         justificativo_id   = v_factura_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_CREAR_FACTURA', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'factura_id', v_factura_id, 'mov_id', v_mov_id,
    'monto', v_monto_abs, 'cat', v_cat, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'factura',
                            'factura_id', v_factura_id, 'mov_id', v_mov_id);
END;
$$;
