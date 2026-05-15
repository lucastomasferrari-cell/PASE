-- ═══════════════════════════════════════════════════════════════════════════
-- Menu Engineering — RPC fn_reporte_menu_engineering_comanda
-- ═══════════════════════════════════════════════════════════════════════════
-- Cuadrante Toast clásico Star/Plowhorse/Puzzle/Dog cruzando popularidad
-- (cantidad vendida) vs margen (precio - costo de receta).
--
-- Clasificación:
--   - star      → alta-pop + alto-margen (vender más, no tocar)
--   - plowhorse → alta-pop + bajo-margen (subir precio o bajar costo)
--   - puzzle    → baja-pop + alto-margen (promocionar / mejor visibilidad)
--   - dog       → baja-pop + bajo-margen (sacar del menú o rediseñar)
--   - sin_receta → no clasificable hasta cargar receta (F1.1)
--
-- Mediana como threshold (no promedio): robusta a outliers (1 item viral
-- no distorsiona el resto).
--
-- Usa fn_snapshot_receta_a_version? NO. Calcula costo de la RECETA VIVA
-- al momento del reporte. Para CMV histórico exacto se usa el snapshot
-- ya capturado por F1.1c en ventas_pos_items.receta_version_id, pero
-- para "cómo me va este mes" la receta viva es lo correcto.

DROP FUNCTION IF EXISTS fn_reporte_menu_engineering_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION fn_reporte_menu_engineering_comanda(
  p_local_id INTEGER,
  p_desde TIMESTAMPTZ,
  p_hasta TIMESTAMPTZ
) RETURNS TABLE (
  item_id INTEGER,
  nombre TEXT,
  emoji TEXT,
  cantidad_vendida NUMERIC,
  total_facturado NUMERIC,
  precio_promedio NUMERIC,
  costo_porcion NUMERIC,
  margen_unitario NUMERIC,
  margen_pct NUMERIC,
  cuadrante TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT fn_check_perm_comanda('comanda.reportes.ver') THEN
    RAISE EXCEPTION 'SIN_PERMISO_REPORTES';
  END IF;

  PERFORM fn_assert_local_autorizado(p_local_id);

  RETURN QUERY
  WITH items_vendidos AS (
    SELECT
      i.id AS item_id,
      i.nombre,
      i.emoji,
      SUM(vpi.cantidad)::NUMERIC AS cantidad_vendida,
      SUM(vpi.subtotal)::NUMERIC AS total_facturado,
      AVG(vpi.precio_unitario)::NUMERIC AS precio_promedio,
      -- Costo por porción: SUM(cantidad * costo_unitario * (1 + merma/100)) / rendimiento
      (
        SELECT SUM(ri.cantidad * ins.costo_actual * (1 + ri.merma_pct / 100.0)) / NULLIF(r.rendimiento, 0)
        FROM recetas r
        LEFT JOIN receta_insumos ri ON ri.receta_id = r.id AND ri.deleted_at IS NULL
        LEFT JOIN insumos ins ON ins.id = ri.insumo_id AND ins.deleted_at IS NULL
        WHERE r.item_id = i.id
          AND r.activa = TRUE
          AND r.deleted_at IS NULL
        GROUP BY r.id, r.rendimiento
        LIMIT 1
      ) AS costo_porcion_calc
    FROM ventas_pos_items vpi
    JOIN ventas_pos vp ON vp.id = vpi.venta_id
    JOIN items i ON i.id = vpi.item_id
    WHERE vp.local_id = p_local_id
      AND vp.estado = 'cobrada'
      AND vp.cobrada_at >= p_desde
      AND vp.cobrada_at <= p_hasta
      AND vpi.estado <> 'anulado'
      AND vpi.deleted_at IS NULL
    GROUP BY i.id, i.nombre, i.emoji
  ),
  con_margenes AS (
    SELECT
      iv.*,
      CASE
        WHEN iv.costo_porcion_calc IS NOT NULL AND iv.precio_promedio > 0
        THEN iv.precio_promedio - iv.costo_porcion_calc
        ELSE NULL
      END AS margen_unitario_calc,
      CASE
        WHEN iv.costo_porcion_calc IS NOT NULL AND iv.precio_promedio > 0
        THEN ((iv.precio_promedio - iv.costo_porcion_calc) / iv.precio_promedio) * 100
        ELSE NULL
      END AS margen_pct_calc
    FROM items_vendidos iv
  ),
  medianas AS (
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cantidad_vendida) AS mediana_pop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY margen_pct_calc) AS mediana_margen
    FROM con_margenes
    WHERE costo_porcion_calc IS NOT NULL
  )
  SELECT
    cm.item_id,
    cm.nombre,
    cm.emoji,
    cm.cantidad_vendida,
    cm.total_facturado,
    cm.precio_promedio,
    cm.costo_porcion_calc AS costo_porcion,
    cm.margen_unitario_calc AS margen_unitario,
    cm.margen_pct_calc AS margen_pct,
    CASE
      WHEN cm.costo_porcion_calc IS NULL THEN 'sin_receta'
      WHEN med.mediana_pop IS NULL OR med.mediana_margen IS NULL THEN 'sin_clasificar'
      WHEN cm.cantidad_vendida >= med.mediana_pop AND cm.margen_pct_calc >= med.mediana_margen THEN 'star'
      WHEN cm.cantidad_vendida >= med.mediana_pop AND cm.margen_pct_calc <  med.mediana_margen THEN 'plowhorse'
      WHEN cm.cantidad_vendida <  med.mediana_pop AND cm.margen_pct_calc >= med.mediana_margen THEN 'puzzle'
      ELSE 'dog'
    END AS cuadrante
  FROM con_margenes cm
  CROSS JOIN medianas med
  ORDER BY cm.cantidad_vendida DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_menu_engineering_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION fn_reporte_menu_engineering_comanda IS
  'Menu Engineering Dashboard (Toast feature). Cuadrante Star/Plowhorse/Puzzle/Dog. Usa receta viva (no snapshot histórico). Mediana como threshold para robustez ante outliers.';
