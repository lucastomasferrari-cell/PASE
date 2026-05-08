-- ═══════════════════════════════════════════════════════════════════════════
-- Facturas — columna `bucket` para clasificar a qué línea del EERR pertenece.
--
-- Contexto: hasta hoy todas las facturas entraban al CMV en EERR/Cierre por
-- el cálculo `totalCMV = sum(facturas.total)`. Eso era correcto cuando solo
-- se cargaban facturas de mercadería. Con la decisión "todo lo que tiene
-- factura va por Compras" (incluye servicios: AySA, Edenor, MP, Rappi, etc),
-- esa fórmula pasa a inflar el CMV con cargos que en realidad son gastos
-- operativos.
--
-- Solución: cada factura guarda su bucket en una columna nueva. Los buckets
-- son los mismos tipos que ya manejan las categorías en config_categorias:
--   'cat_compra' → CMV
--   'gasto_fijo' / 'gasto_variable' / 'gasto_publicidad' / 'gasto_comision'
--   / 'gasto_impuesto' → respectivos buckets de gastos
-- NULL = factura legacy (cargada antes de este cambio). EERR las trata como
-- CMV para preservar el reporte histórico.
--
-- El frontend setea el bucket al crear factura, derivándolo del tipo de la
-- categoría seleccionada (vía config_categorias.tipo). Las RPCs que crean
-- facturas (fn_conciliar_mp_con_factura_nueva) hacen el lookup también.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE facturas
  ADD COLUMN IF NOT EXISTS bucket TEXT NULL;

-- CHECK con nombre explícito para poder DROPearlo si algún día sumamos tipos
-- nuevos. Solo permite los valores conocidos + NULL (legacy).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'facturas_bucket_check'
  ) THEN
    ALTER TABLE facturas
      ADD CONSTRAINT facturas_bucket_check
      CHECK (bucket IS NULL OR bucket IN (
        'cat_compra',
        'gasto_fijo', 'gasto_variable', 'gasto_publicidad',
        'gasto_comision', 'gasto_impuesto'
      ));
  END IF;
END$$;

COMMENT ON COLUMN facturas.bucket IS
  'Tipo de gasto al que pertenece la factura, derivado de la categoría '
  'seleccionada (vía config_categorias.tipo). NULL = factura legacy '
  'pre-2026-05-13: EERR la trata como CMV para preservar el reporte '
  'histórico.';

-- Update RPC fn_conciliar_mp_con_factura_nueva para setear el bucket.
-- Lookup la categoría en config_categorias y guarda su tipo.
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
  v_bucket       text;
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
  v_fecha := COALESCE(
    nullif(p_factura_data->>'fecha', '')::date,
    (v_mp.fecha)::date,
    current_date
  );

  SELECT EXISTS(SELECT 1 FROM proveedores WHERE id = v_prov_id AND tenant_id = v_mp.tenant_id)
    INTO v_prov_existe;
  IF NOT v_prov_existe THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

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
    'monto', v_monto_abs, 'usuario_id', v_usuario_id, 'bucket', v_bucket
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'factura',
                            'factura_id', v_factura_id, 'mov_id', v_mov_id,
                            'bucket', v_bucket);
END;
$$;
