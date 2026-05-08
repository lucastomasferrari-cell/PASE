-- ═══════════════════════════════════════════════════════════════════════════
-- MP conciliación — simplificación.
--
-- 1. DROP RPC fn_conciliar_mp_con_egreso_manual (Lucas: no se debe poder
--    hacer egresos manuales en ninguna parte del sistema; todo egreso debe
--    pasar por gasto categorizado, factura, remito o movimiento interno).
--    Las filas legacy con justificativo_tipo='egreso_manual' se mantienen
--    intactas — la columna sigue aceptando ese valor en el CHECK existente
--    para no romper la integridad histórica. Si en el futuro hay que
--    migrarlas a 'gasto', se hace en otra migration con backfill explícito.
--
-- 2. ADD RPC fn_conciliar_mp_con_factura_nueva — crea factura mínima
--    (proveedor + nro + fecha + cat + detalle, totales = abs(monto MP) en
--    'neto' con IVA en 0) + movimiento contable + linkea atómicamente.
--    IVA/percepciones quedan en 0; el usuario puede completar después en
--    Compras si los necesita.
--
-- 3. ADD RPC fn_conciliar_mp_con_remito_nuevo — idem para remito.
--
-- Ambas RPCs nuevas usan _validar_mp_mov_conciliable() que ya existe.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1) Drop egreso_manual RPC ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS fn_conciliar_mp_con_egreso_manual(text, jsonb);

-- ─── 2) Crear factura nueva + linkear ───────────────────────────────────────
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
  v_detalle      text;
  v_prov_existe  boolean;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_prov_id := (p_factura_data->>'prov_id')::integer;
  IF v_prov_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_REQUERIDO'; END IF;
  v_nro := nullif(trim(p_factura_data->>'nro'), '');
  IF v_nro IS NULL THEN RAISE EXCEPTION 'NRO_REQUERIDO'; END IF;
  v_cat     := COALESCE(nullif(trim(p_factura_data->>'cat'), ''), 'Conciliación MP');
  v_detalle := COALESCE(p_factura_data->>'detalle', '');

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  -- Si el form no pasa fecha, usa la del egreso MP.
  v_fecha := COALESCE(
    nullif(p_factura_data->>'fecha', '')::date,
    (v_mp.fecha)::date,
    current_date
  );

  -- Proveedor debe existir y pertenecer al mismo tenant.
  SELECT EXISTS(SELECT 1 FROM proveedores WHERE id = v_prov_id AND tenant_id = v_mp.tenant_id)
    INTO v_prov_existe;
  IF NOT v_prov_existe THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  -- Insert factura: total = abs(monto MP), neto = total (sin IVA), resto en 0.
  -- Estado 'pagada' porque el egreso MP ya ocurrió. tipo='factura' por default.
  v_factura_id := _gen_id('FAC');
  INSERT INTO facturas (
    id, prov_id, local_id, nro, fecha, venc, neto, iva21, iva105, iibb,
    total, cat, estado, detalle, pagos, tipo, perc_iva, otros_cargos, descuentos,
    tenant_id
  ) VALUES (
    v_factura_id, v_prov_id, v_mp.local_id, v_nro, v_fecha, NULL,
    v_monto_abs, 0, 0, 0,
    v_monto_abs, v_cat, 'pagada',
    COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
    jsonb_build_array(jsonb_build_object('fecha', v_fecha, 'monto', v_monto_abs, 'cuenta', 'MercadoPago')),
    'factura', 0, 0, 0,
    v_mp.tenant_id
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
    'monto', v_monto_abs, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'factura',
                            'factura_id', v_factura_id, 'mov_id', v_mov_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_factura_nueva(text, jsonb) TO authenticated;

-- ─── 3) Crear remito nuevo + linkear ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_remito_nuevo(
  p_mp_mov_id    text,
  p_remito_data  jsonb       -- { prov_id (int), nro, fecha?, cat?, detalle? }
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp           RECORD;
  v_usuario_id   integer;
  v_remito_id    text;
  v_mov_id       text;
  v_monto_abs    numeric;
  v_prov_id      integer;
  v_nro          text;
  v_fecha        date;
  v_cat          text;
  v_detalle      text;
  v_prov_existe  boolean;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_prov_id := (p_remito_data->>'prov_id')::integer;
  IF v_prov_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_REQUERIDO'; END IF;
  v_nro := nullif(trim(p_remito_data->>'nro'), '');
  IF v_nro IS NULL THEN RAISE EXCEPTION 'NRO_REQUERIDO'; END IF;
  v_cat     := nullif(trim(p_remito_data->>'cat'), '');
  v_detalle := COALESCE(p_remito_data->>'detalle', '');

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  v_fecha := COALESCE(
    nullif(p_remito_data->>'fecha', '')::date,
    (v_mp.fecha)::date,
    current_date
  );

  SELECT EXISTS(SELECT 1 FROM proveedores WHERE id = v_prov_id AND tenant_id = v_mp.tenant_id)
    INTO v_prov_existe;
  IF NOT v_prov_existe THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  -- Insert remito: estado 'pagado' porque el egreso MP ya ocurrió.
  v_remito_id := _gen_id('REM');
  INSERT INTO remitos (
    id, prov_id, local_id, nro, fecha, monto, cat, detalle, estado, factura_id, tenant_id
  ) VALUES (
    v_remito_id, v_prov_id, v_mp.local_id, v_nro, v_fecha, v_monto_abs,
    v_cat, COALESCE(nullif(v_detalle, ''), 'Conciliación MP'), 'pagado', NULL,
    v_mp.tenant_id
  );

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
    VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Remito',
            COALESCE(v_cat, 'Conciliación MP'),
            -v_monto_abs, COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
            v_mp.local_id, v_mp.tenant_id, NULL);

  PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_monto_abs);

  UPDATE mp_movimientos
     SET justificativo_tipo = 'remito',
         justificativo_id   = v_remito_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_CREAR_REMITO', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'remito_id', v_remito_id, 'mov_id', v_mov_id,
    'monto', v_monto_abs, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'remito',
                            'remito_id', v_remito_id, 'mov_id', v_mov_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_remito_nuevo(text, jsonb) TO authenticated;
