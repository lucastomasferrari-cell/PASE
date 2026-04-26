-- ═══════════════════════════════════════════════════════════════════════════
-- Taxonomía canónica: columna grupo en config_categorias + seed de categorías
-- de INGRESOS + cleanup de movimientos legacy + RPC crear_gasto deriva
-- gastos.tipo del grupo de la categoría elegida.
--
-- Contexto: reporte Fase 2 del batch α. tipo de movimientos queda como valor
-- canónico seteado por código/RPC; cat de movimientos y categoria de gastos
-- se resuelven contra config_categorias con columna grupo para agrupar en
-- EERR/Cashflow sin tocar gastos.tipo (que sigue existiendo por retro compat).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Columna grupo. NULL para filas con tipo='medio_cobro' (los medios de
-- venta no se mapean a un grupo contable — no van a EERR ni a Cashflow como
-- tales; el impacto se registra vía movimientos con su propio cat).
ALTER TABLE config_categorias ADD COLUMN IF NOT EXISTS grupo text;

-- 2) Mapeo de grupo desde el tipo existente. Sólo sobreescribe cuando grupo
-- es NULL (migración idempotente).
UPDATE config_categorias SET grupo = 'CMV'              WHERE tipo = 'cat_compra'        AND grupo IS NULL;
UPDATE config_categorias SET grupo = 'Gastos Fijos'     WHERE tipo = 'gasto_fijo'        AND grupo IS NULL;
UPDATE config_categorias SET grupo = 'Gastos Variables' WHERE tipo = 'gasto_variable'    AND grupo IS NULL;
UPDATE config_categorias SET grupo = 'Publicidad y MKT' WHERE tipo = 'gasto_publicidad'  AND grupo IS NULL;
UPDATE config_categorias SET grupo = 'Comisiones'       WHERE tipo = 'gasto_comision'    AND grupo IS NULL;
UPDATE config_categorias SET grupo = 'Impuestos'        WHERE tipo = 'gasto_impuesto'    AND grupo IS NULL;
-- medio_cobro queda NULL (no se mapea a grupo contable).
-- Sueldos se deriva de rrhh_liquidaciones, no desde config_categorias.

-- 3) Seed de las 11 categorías de INGRESOS.
-- Usa WHERE NOT EXISTS para ser idempotente (no hay UNIQUE en (tipo,nombre)).
INSERT INTO config_categorias (tipo, nombre, orden, grupo, activo)
SELECT v.tipo, v.nombre, v.orden, v.grupo, v.activo
FROM (VALUES
  ('cat_ingreso', 'Liquidación Rappi',        1, 'INGRESOS', true),
  ('cat_ingreso', 'Liquidación MercadoPago',  2, 'INGRESOS', true),
  ('cat_ingreso', 'Liquidación PedidosYa',    3, 'INGRESOS', true),
  ('cat_ingreso', 'Liquidación Evento',       4, 'INGRESOS', true),
  ('cat_ingreso', 'Liquidación Bigbox',       5, 'INGRESOS', true),
  ('cat_ingreso', 'Liquidación Fanbag',       6, 'INGRESOS', true),
  ('cat_ingreso', 'Liquidación Nave',         7, 'INGRESOS', true),
  ('cat_ingreso', 'Ingreso Socio',            8, 'INGRESOS', true),
  ('cat_ingreso', 'Devolución Proveedor',     9, 'INGRESOS', true),
  ('cat_ingreso', 'Otro Ingreso',            10, 'INGRESOS', true),
  ('cat_ingreso', 'Transferencia Varios',    11, 'INGRESOS', true)
) AS v(tipo, nombre, orden, grupo, activo)
WHERE NOT EXISTS (
  SELECT 1 FROM config_categorias cc
  WHERE cc.tipo = v.tipo AND cc.nombre = v.nombre
);

-- 4) Cleanup de movimientos legacy identificados en Fase 2.
-- PAPELERÍA (con tilde) → PAPELERIA (canónico del catálogo).
UPDATE movimientos SET cat = 'PAPELERIA' WHERE cat = 'PAPELERÍA';

-- "Pago Gasto" es el default hardcoded pre-commit c2a2be6 (fix bug #13).
-- Ya no se genera más desde el frontend. Las filas viejas se normalizan a
-- "Egreso Manual" (fallback seguro — si más adelante querés mapearlas a
-- "Gasto fijo"/"Gasto variable" cruzando por cat, se puede hacer aparte).
UPDATE movimientos SET tipo = 'Egreso Manual' WHERE tipo = 'Pago Gasto';

-- 5) RPC crear_gasto: deriva gastos.tipo del grupo de la categoría elegida.
-- Mantener gastos.tipo (EERR filtra por él). p_tipo queda opcional y sólo
-- se usa como fallback si la categoría no tiene grupo en config_categorias.
CREATE OR REPLACE FUNCTION crear_gasto(
  p_fecha date,
  p_local_id int,
  p_categoria text,
  p_tipo text,
  p_monto numeric,
  p_detalle text,
  p_cuenta text,
  p_plantilla_id int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_gasto_id text;
  v_mov_id text;
  v_grupo text;
  v_tipo_final text;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR p_categoria = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);

  -- Deriva tipo del grupo de la categoría cuando está en config_categorias
  -- como gasto_*. Si la categoría es cat_compra (CMV), ingreso, o no está en
  -- el catálogo, usa p_tipo del cliente como fallback.
  SELECT grupo INTO v_grupo FROM config_categorias
  WHERE nombre = p_categoria AND tipo LIKE 'gasto_%' AND activo = true
  LIMIT 1;

  v_tipo_final := CASE v_grupo
    WHEN 'Gastos Fijos'     THEN 'fijo'
    WHEN 'Gastos Variables' THEN 'variable'
    WHEN 'Publicidad y MKT' THEN 'publicidad'
    WHEN 'Comisiones'       THEN 'comision'
    WHEN 'Impuestos'        THEN 'impuesto'
    ELSE p_tipo
  END;

  v_gasto_id := _gen_id('GASTO');
  INSERT INTO gastos (id, fecha, local_id, categoria, tipo, monto, detalle, cuenta, plantilla_id)
  VALUES (v_gasto_id, p_fecha, p_local_id, p_categoria, v_tipo_final, p_monto, p_detalle, p_cuenta, p_plantilla_id);

  IF p_local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, gasto_id_ref)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Gasto ' || COALESCE(v_tipo_final, ''),
    p_categoria, -p_monto, COALESCE(p_detalle, p_categoria), p_local_id, v_gasto_id);

  PERFORM _auditar('gastos', 'CREAR', jsonb_build_object(
    'gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'monto', p_monto,
    'categoria', p_categoria, 'tipo', v_tipo_final, 'grupo', v_grupo,
    'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'tipo', v_tipo_final);
END;
$$;
