-- ─── CMV reporte: versión optimizada (sin N+1) + comparativa período ────────
-- Reemplaza fn_reporte_cmv con versión que pre-resuelve los costos de
-- insumos en un solo JOIN, evitando subquery por fila (auditoría detectó
-- N+1 latente cuando hay >50 items).
--
-- Además agrega fn_reporte_cmv_resumen para tener KPIs agregados en 1 call
-- (sin traer toda la tabla cuando solo querés "ingreso total / costo / CMV%").

CREATE OR REPLACE FUNCTION fn_reporte_cmv(
  p_local_id INTEGER,
  p_fecha_desde DATE,
  p_fecha_hasta DATE
)
RETURNS TABLE (
  item_id INTEGER,
  item_nombre TEXT,
  item_emoji TEXT,
  cantidad_vendida NUMERIC,
  ingreso_total NUMERIC,
  costo_total NUMERIC,
  costo_unitario_promedio NUMERIC,
  margen_total NUMERIC,
  cmv_pct NUMERIC,
  sin_receta_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'SIN_TENANT'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;

  RETURN QUERY
  WITH
  -- 1. Costos de insumos al día (1 row por insumo del tenant)
  insumos_costo AS (
    SELECT i.id, COALESCE(i.costo_actual, 0) AS costo
    FROM insumos i
    WHERE i.tenant_id = v_tenant_id AND i.deleted_at IS NULL
  ),
  -- 2. Para cada receta_version, calcular costo por porción (suma de insumos
  --    expandidos del JSONB × costo del insumo, dividido por rendimiento).
  --    Esto se evalúa UNA vez por receta_version, no por venta.
  recetas_costo AS (
    SELECT
      rv.id AS receta_version_id,
      COALESCE(
        (
          SELECT SUM(
            (ing->>'cantidad')::NUMERIC
            * COALESCE(ic.costo, 0)
            * (1 + COALESCE((ing->>'merma_pct')::NUMERIC, 0) / 100.0)
          )
          FROM jsonb_array_elements(rv.receta_data->'insumos') AS ing
          LEFT JOIN insumos_costo ic ON ic.id = (ing->>'insumo_id')::INTEGER
        ) / NULLIF((rv.receta_data->>'rendimiento')::NUMERIC, 0),
        0
      ) AS costo_por_porcion
    FROM recetas_versiones rv
    WHERE rv.tenant_id = v_tenant_id
      AND rv.receta_data ? 'insumos'
      AND rv.id IN (
        SELECT DISTINCT receta_version_id
        FROM ventas_pos_items vpi
        JOIN ventas_pos v ON v.id = vpi.venta_id
        WHERE v.tenant_id = v_tenant_id
          AND v.local_id = p_local_id
          AND v.estado = 'cobrada'
          AND v.cobrada_at::DATE BETWEEN p_fecha_desde AND p_fecha_hasta
          AND vpi.receta_version_id IS NOT NULL
      )
  ),
  -- 3. Cruzar ventas con costos pre-resueltos (sin subquery por fila)
  items_vendidos AS (
    SELECT
      vpi.item_id,
      vpi.cantidad,
      vpi.subtotal,
      vpi.receta_version_id,
      COALESCE(rc.costo_por_porcion * vpi.cantidad, 0) AS costo_linea,
      (vpi.receta_version_id IS NULL) AS sin_receta
    FROM ventas_pos v
    JOIN ventas_pos_items vpi ON vpi.venta_id = v.id
    LEFT JOIN recetas_costo rc ON rc.receta_version_id = vpi.receta_version_id
    WHERE v.tenant_id = v_tenant_id
      AND v.local_id = p_local_id
      AND v.estado = 'cobrada'
      AND v.cobrada_at::DATE BETWEEN p_fecha_desde AND p_fecha_hasta
      AND vpi.estado != 'anulado'
  ),
  agregado AS (
    SELECT
      iv.item_id,
      SUM(iv.cantidad) AS cantidad_total,
      SUM(iv.subtotal) AS ingreso_total,
      SUM(iv.costo_linea) AS costo_total,
      COUNT(*) FILTER (WHERE iv.sin_receta)::INTEGER AS sin_receta
    FROM items_vendidos iv
    GROUP BY iv.item_id
  )
  SELECT
    a.item_id,
    i.nombre,
    i.emoji,
    a.cantidad_total,
    a.ingreso_total,
    a.costo_total,
    CASE WHEN a.cantidad_total > 0 THEN a.costo_total / a.cantidad_total ELSE 0 END,
    a.ingreso_total - a.costo_total,
    CASE WHEN a.ingreso_total > 0 THEN a.costo_total / a.ingreso_total ELSE 0 END,
    a.sin_receta
  FROM agregado a
  JOIN items i ON i.id = a.item_id
  ORDER BY a.ingreso_total DESC;
END;
$$;

-- ─── Resumen agregado (1 row con KPIs) — sirve para chips de dashboard ──────
CREATE OR REPLACE FUNCTION fn_reporte_cmv_resumen(
  p_local_id INTEGER,
  p_fecha_desde DATE,
  p_fecha_hasta DATE
)
RETURNS TABLE (
  total_ingreso NUMERIC,
  total_costo NUMERIC,
  total_margen NUMERIC,
  cmv_pct NUMERIC,
  items_distintos INTEGER,
  items_sin_receta INTEGER,
  items_margen_negativo INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(ingreso_total), 0),
    COALESCE(SUM(costo_total), 0),
    COALESCE(SUM(margen_total), 0),
    CASE WHEN SUM(ingreso_total) > 0 THEN SUM(costo_total) / SUM(ingreso_total) ELSE 0 END,
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE sin_receta_count > 0)::INTEGER,
    COUNT(*) FILTER (WHERE margen_total < 0 AND costo_total > 0)::INTEGER
  FROM fn_reporte_cmv(p_local_id, p_fecha_desde, p_fecha_hasta);
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_cmv(INTEGER, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_reporte_cmv_resumen(INTEGER, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
