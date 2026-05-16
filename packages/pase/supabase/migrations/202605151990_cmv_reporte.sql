-- ─── Reporte CMV cruce ventas × recetas ────────────────────────────────────
-- RPC fn_reporte_cmv(local_id, fecha_desde, fecha_hasta) que cruza:
--   - ventas_pos (cobradas en el rango, no anuladas)
--   - ventas_pos_items (con receta_version_id si existe)
--   - recetas_versiones (receta_data JSONB con [{ insumo_id, cantidad, merma_pct }])
--   - insumos.costo_actual (referencia, no se usa por item — se usa el snapshot
--     embebido en receta_data o el costo del momento si se grabó)
--
-- Devuelve por item:
--   - cantidad_vendida total en el período
--   - ingreso_total (subtotal sumado)
--   - costo_total estimado (basado en receta_data + costos en JSONB si los tiene)
--   - margen (ingreso - costo)
--   - cmv_pct (costo / ingreso)
--
-- Items SIN receta_version_id quedan con costo NULL y aparecen flagged.

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
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;

  -- Validar acceso al local
  IF NOT (
    auth_es_dueno_o_admin() OR
    p_local_id = ANY(auth_locales_visibles())
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;

  RETURN QUERY
  WITH items_vendidos AS (
    SELECT
      vpi.item_id,
      vpi.cantidad,
      vpi.subtotal,
      vpi.receta_version_id,
      rv.receta_data
    FROM ventas_pos v
    JOIN ventas_pos_items vpi ON vpi.venta_id = v.id
    LEFT JOIN recetas_versiones rv ON rv.id = vpi.receta_version_id
    WHERE v.tenant_id = v_tenant_id
      AND v.local_id = p_local_id
      AND v.estado = 'cobrada'
      AND v.cobrada_at::DATE BETWEEN p_fecha_desde AND p_fecha_hasta
      AND vpi.estado != 'anulado'
  ),
  costos_por_item AS (
    SELECT
      iv.item_id,
      SUM(iv.cantidad) AS cantidad_total,
      SUM(iv.subtotal) AS ingreso_total,
      -- Para cada fila con receta_data, calcular costo de esa porción
      -- sumando insumo.cantidad * insumo.costo_actual * (1 + merma/100).
      -- receta_data debe tener forma: { rendimiento: N, insumos: [{insumo_id, cantidad, merma_pct}] }
      SUM(
        CASE
          WHEN iv.receta_data IS NOT NULL AND iv.receta_data ? 'insumos' THEN
            iv.cantidad * (
              SELECT COALESCE(SUM(
                (ing->>'cantidad')::NUMERIC
                * COALESCE(ins.costo_actual, 0)
                * (1 + COALESCE((ing->>'merma_pct')::NUMERIC, 0) / 100)
              ), 0) / GREATEST((iv.receta_data->>'rendimiento')::NUMERIC, 1)
              FROM jsonb_array_elements(iv.receta_data->'insumos') AS ing
              LEFT JOIN insumos ins ON ins.id = (ing->>'insumo_id')::INTEGER
            )
          ELSE 0
        END
      ) AS costo_total,
      COUNT(*) FILTER (WHERE iv.receta_version_id IS NULL)::INTEGER AS sin_receta
    FROM items_vendidos iv
    GROUP BY iv.item_id
  )
  SELECT
    cpi.item_id,
    i.nombre,
    i.emoji,
    cpi.cantidad_total,
    cpi.ingreso_total,
    cpi.costo_total,
    CASE WHEN cpi.cantidad_total > 0 THEN cpi.costo_total / cpi.cantidad_total ELSE 0 END,
    cpi.ingreso_total - cpi.costo_total,
    CASE WHEN cpi.ingreso_total > 0 THEN cpi.costo_total / cpi.ingreso_total ELSE 0 END,
    cpi.sin_receta
  FROM costos_por_item cpi
  JOIN items i ON i.id = cpi.item_id
  ORDER BY cpi.ingreso_total DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_cmv(INTEGER, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
