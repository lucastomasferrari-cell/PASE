-- Fix: floating-point en montos de pagos NC causaba que facturas fully-paid
-- quedaran en estado='pendiente' (el SUM daba 0.0000001 menos que el total).
--
-- Causa: JavaScript pasaba p_monto con decimales flotantes (ej 3068.8699999999953
-- en vez de 3068.87). La RPC guardaba ese float en el JSONB pagos y después la
-- comparación SUM(pagos) >= total fallaba por la millonésima.
--
-- Fix doble:
-- 1) Parche a aplicar_nc_a_factura y pagar_factura: ROUND(p_monto, 2) al inicio.
-- 2) Data-fix: corregir pagos con floats rotos + setear estado='pagada' donde
--    corresponda.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Parche aplicar_nc_a_factura: redondear p_monto al inicio
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION aplicar_nc_a_factura(
  p_nc_id      text,
  p_factura_id text,
  p_monto      numeric,
  p_fecha      date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nc           RECORD;
  v_fac          RECORD;
  v_tenant       uuid;
  v_usuario_id   integer;
  v_nc_aplicado  numeric;
  v_nc_disp      numeric;
  v_fac_pagado   numeric;
  v_fac_pendiente numeric;
  v_nuevo_pagos  jsonb;
  v_nuevo_estado_fac text;
  v_nuevo_estado_nc  text;
BEGIN
  -- Sanitizar float de JS
  p_monto := ROUND(p_monto, 2);

  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_fecha IS NULL THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;

  SELECT * INTO v_nc FROM facturas WHERE id = p_nc_id FOR UPDATE;
  IF v_nc IS NULL THEN RAISE EXCEPTION 'NC_NO_ENCONTRADA'; END IF;
  IF v_nc.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NC_CROSS_TENANT'; END IF;
  IF (v_nc.tipo IS NULL OR v_nc.tipo <> 'nota_credito') THEN RAISE EXCEPTION 'NC_TIPO_INVALIDO'; END IF;
  IF v_nc.estado = 'anulada' THEN RAISE EXCEPTION 'NC_ANULADA'; END IF;
  IF v_nc.estado = 'pagada'  THEN RAISE EXCEPTION 'NC_YA_CONSUMIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.tenant_id <> v_tenant THEN RAISE EXCEPTION 'FACTURA_CROSS_TENANT'; END IF;
  IF (COALESCE(v_fac.tipo, 'factura') = 'nota_credito') THEN RAISE EXCEPTION 'FACTURA_TIPO_INVALIDO'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada'  THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  IF v_nc.prov_id IS DISTINCT FROM v_fac.prov_id THEN
    RAISE EXCEPTION 'NC_PROVEEDOR_DISTINTO';
  END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_nc_aplicado
    FROM nc_aplicaciones WHERE nc_id = p_nc_id;
  v_nc_disp := abs(v_nc.total) - v_nc_aplicado;
  IF p_monto > v_nc_disp THEN
    RAISE EXCEPTION 'NC_SALDO_INSUFICIENTE';
  END IF;

  SELECT COALESCE(SUM(ROUND((e->>'monto')::numeric, 2)), 0) INTO v_fac_pagado
    FROM jsonb_array_elements(COALESCE(v_fac.pagos, '[]'::jsonb)) e;
  v_fac_pendiente := v_fac.total - v_fac_pagado;
  IF p_monto > v_fac_pendiente + 0.01 THEN
    RAISE EXCEPTION 'FACTURA_MONTO_EXCEDE_PENDIENTE';
  END IF;

  INSERT INTO nc_aplicaciones (nc_id, factura_id, monto, fecha, tenant_id, usuario_id)
  VALUES (p_nc_id, p_factura_id, p_monto, p_fecha, v_tenant, v_usuario_id);

  v_nuevo_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'cuenta', 'Nota de Crédito',
      'monto', p_monto,
      'fecha', p_fecha,
      'tipo', 'nc',
      'nc_id', p_nc_id
    )
  );
  v_nuevo_estado_fac := CASE
    WHEN ROUND(v_fac_pagado + p_monto, 2) >= v_fac.total THEN 'pagada'
    ELSE v_fac.estado
  END;
  UPDATE facturas
     SET pagos = v_nuevo_pagos, estado = v_nuevo_estado_fac
   WHERE id = p_factura_id;

  v_nuevo_estado_nc := CASE
    WHEN ROUND(v_nc_aplicado + p_monto, 2) >= abs(v_nc.total) THEN 'pagada'
    ELSE v_nc.estado
  END;
  IF v_nuevo_estado_nc <> v_nc.estado THEN
    UPDATE facturas SET estado = v_nuevo_estado_nc WHERE id = p_nc_id;
  END IF;

  PERFORM _auditar('facturas', 'APLICAR_NC', jsonb_build_object(
    'nc_id', p_nc_id, 'factura_id', p_factura_id, 'monto', p_monto,
    'usuario_id', v_usuario_id,
    'nc_estado_nuevo', v_nuevo_estado_nc, 'fac_estado_nuevo', v_nuevo_estado_fac
  ), v_tenant);

  RETURN jsonb_build_object(
    'nc_id', p_nc_id,
    'factura_id', p_factura_id,
    'monto', p_monto,
    'nc_estado', v_nuevo_estado_nc,
    'fac_estado', v_nuevo_estado_fac,
    'nc_saldo_restante', v_nc_disp - p_monto,
    'fac_saldo_pendiente', v_fac_pendiente - p_monto
  );
END;
$$;

GRANT EXECUTE ON FUNCTION aplicar_nc_a_factura(text, text, numeric, date) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Data-fix: redondear montos flotantes en pagos JSONB + corregir estado
-- ═══════════════════════════════════════════════════════════════════════

-- Fix pagos array: redondear cada monto a 2 decimales
UPDATE facturas
SET pagos = (
  SELECT jsonb_agg(
    jsonb_set(elem, '{monto}', to_jsonb(ROUND((elem->>'monto')::numeric, 2)))
  )
  FROM jsonb_array_elements(pagos) elem
)
WHERE pagos IS NOT NULL
  AND pagos <> '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(pagos) e
    WHERE ROUND((e->>'monto')::numeric, 2) <> (e->>'monto')::numeric
  );

-- Fix estado: facturas con pagos (redondeados) >= total pero estado pendiente
UPDATE facturas
SET estado = 'pagada'
WHERE estado = 'pendiente'
  AND COALESCE(tipo, 'factura') = 'factura'
  AND total > 0
  AND COALESCE((
    SELECT SUM(ROUND((e->>'monto')::numeric, 2))
    FROM jsonb_array_elements(COALESCE(pagos, '[]'::jsonb)) e
  ), 0) >= total;

-- Fix estado: NCs consumidas (aplicaciones suman >= abs(total)) pero estado pendiente
UPDATE facturas
SET estado = 'pagada'
WHERE estado = 'pendiente'
  AND tipo = 'nota_credito'
  AND EXISTS (
    SELECT 1 FROM nc_aplicaciones nc
    WHERE nc.nc_id = facturas.id
    GROUP BY nc.nc_id
    HAVING SUM(nc.monto) >= abs(facturas.total) - 0.01
  );

COMMIT;
