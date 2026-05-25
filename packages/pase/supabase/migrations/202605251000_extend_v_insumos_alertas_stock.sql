-- ─────────────────────────────────────────────────────────────────────────
-- Extender v_insumos_alertas_stock con categoria_pl + ubicacion + descripcion
-- ─────────────────────────────────────────────────────────────────────────
--
-- TabStock (Rentabilidad → Stock) usa estas 3 columnas pero antes hacía
-- query directa a `insumos`. Para mostrar la nueva columna "Días que aguanta"
-- (cálculo basado en últimas 4 semanas de ventas) necesita las cols de la
-- vista. Más simple agregar las 3 cols faltantes a la vista que duplicar el
-- cálculo en el frontend.
--
-- Cierra el ticket "Mostrar 'Días que aguanta' en TabStock" anotado el
-- 24-may como gap del módulo Stock.
--
-- Compat: el único consumer hoy (`insumosService.ts:195` en COMANDA)
-- selecciona `*` y solo lee `alerta_nivel` — agregar columnas no rompe nada.
-- ─────────────────────────────────────────────────────────────────────────

-- CREATE OR REPLACE VIEW requiere mantener el orden de columnas existentes.
-- Las 3 columnas nuevas (descripcion, ubicacion, categoria_pl) van AL FINAL
-- para no romper el contract de la vista vieja.
CREATE OR REPLACE VIEW v_insumos_alertas_stock AS
SELECT
  -- Columnas EXISTENTES (mismo orden que la vista vieja)
  id,
  tenant_id,
  local_id,
  nombre,
  unidad,
  emoji,
  stock_actual,
  stock_minimo,
  stock_maximo,
  costo_actual,
  CASE
    WHEN (stock_minimo IS NOT NULL) AND (stock_actual <= 0::NUMERIC) THEN 'agotado'
    WHEN (stock_minimo IS NOT NULL) AND (stock_actual < stock_minimo) THEN 'bajo'
    WHEN (stock_maximo IS NOT NULL) AND (stock_actual > stock_maximo) THEN 'sobrestock'
    ELSE 'ok'
  END AS alerta_nivel,
  CASE
    WHEN stock_actual > 0::NUMERIC THEN
      stock_actual / NULLIF((
        SELECT (-SUM(im.cantidad)) / 30.0
          FROM insumo_movimientos im
         WHERE im.insumo_id = i.id
           AND im.tipo = 'salida_venta'
           AND im.created_at > (now() - INTERVAL '30 days')
           AND im.deleted_at IS NULL
      ), 0::NUMERIC)
    ELSE 0::NUMERIC
  END AS dias_estimados_restantes,
  -- Columnas NUEVAS (al final, no rompe consumers que selecten *)
  descripcion,
  ubicacion,
  categoria_pl
FROM insumos i
WHERE deleted_at IS NULL AND activo = TRUE;

COMMENT ON VIEW v_insumos_alertas_stock IS
  'Vista de insumos con stock + alertas + días estimados restantes (basado '
  'en consumo promedio últimos 30d). Fix 25-may: agregadas columnas '
  'categoria_pl, ubicacion, descripcion para que TabStock muestre todo '
  'sin necesidad de JOIN extra.';
