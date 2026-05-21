-- ═══════════════════════════════════════════════════════════════════════════
-- CMV Real: el otro lado de la moneda del CMV teórico
--
-- El CMV teórico (ya implementado en fn_reporte_cmv) calcula lo que las
-- recetas dicen que se debería haber consumido. Pero la verdad de la
-- gastronomía está en la diferencia con la realidad.
--
-- Fórmula contable estándar:
--   Consumo Real = Stock Inicial + Compras − Stock Final − Mermas declaradas
--
-- Donde la "diferencia" entre Real y Teórico es la PÉRDIDA NO EXPLICADA
-- (porcionado de más, fugas, robos no declarados, errores de carga).
--
-- Eficiencia = CMV_teorico / CMV_real (0-1)
--   100% → cocina perfecta, todo se justifica
--   80%  → 20% se pierde en algo que no detectamos
--
-- Esta función opera POR INSUMO. La vista v_cmv_eficiencia agrega.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_cmv_real(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
) RETURNS TABLE (
  insumo_id BIGINT,
  insumo_nombre TEXT,
  unidad TEXT,
  -- Componentes del balance
  stock_inicial NUMERIC,
  compras_cantidad NUMERIC,
  compras_valor NUMERIC,
  mermas_cantidad NUMERIC,
  mermas_valor NUMERIC,
  stock_final NUMERIC,
  -- Consumo derivado de la fórmula
  consumo_real_cantidad NUMERIC,
  consumo_real_valor NUMERIC,
  -- Consumo según recetas (CMV teórico)
  consumo_teorico_cantidad NUMERIC,
  consumo_teorico_valor NUMERIC,
  -- Diferencia
  diferencia_cantidad NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  -- Costo promedio del período (para reportes valorizados)
  costo_promedio NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH
  -- Stock inicial: stock_antes del primer movimiento del período. Si no
  -- hay movimientos en el período, asumimos stock_actual del insumo.
  stock_ini AS (
    SELECT
      i.id AS insumo_id,
      COALESCE(
        (SELECT im.stock_antes
           FROM insumo_movimientos im
          WHERE im.insumo_id = i.id
            AND im.local_id = p_local_id
            AND im.tenant_id = p_tenant_id
            AND im.created_at::DATE >= p_desde
            AND im.deleted_at IS NULL
          ORDER BY im.created_at ASC
          LIMIT 1),
        COALESCE(i.stock_actual, 0)
      ) AS stock_inicial
    FROM insumos i
    WHERE i.tenant_id = p_tenant_id
      AND (i.local_id = p_local_id OR i.local_id IS NULL)
      AND i.deleted_at IS NULL
      AND i.activo = TRUE
  ),
  -- Stock final: stock_despues del último movimiento del período. Si no
  -- hay, asumimos stock_actual.
  stock_fin AS (
    SELECT
      i.id AS insumo_id,
      COALESCE(
        (SELECT im.stock_despues
           FROM insumo_movimientos im
          WHERE im.insumo_id = i.id
            AND im.local_id = p_local_id
            AND im.tenant_id = p_tenant_id
            AND im.created_at::DATE <= p_hasta
            AND im.deleted_at IS NULL
          ORDER BY im.created_at DESC
          LIMIT 1),
        COALESCE(i.stock_actual, 0)
      ) AS stock_final
    FROM insumos i
    WHERE i.tenant_id = p_tenant_id
      AND (i.local_id = p_local_id OR i.local_id IS NULL)
      AND i.deleted_at IS NULL
      AND i.activo = TRUE
  ),
  -- Compras del período: suma de entrada_compra
  compras AS (
    SELECT
      im.insumo_id,
      SUM(im.cantidad) AS cantidad,
      SUM(im.cantidad * COALESCE(im.costo_unitario, 0)) AS valor
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.tipo = 'entrada_compra'
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  ),
  -- Mermas declaradas (suma absoluta porque la cantidad de mermas suele ser negativa)
  mermas AS (
    SELECT
      im.insumo_id,
      SUM(ABS(im.cantidad)) AS cantidad,
      SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, 0)) AS valor
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.tipo IN ('merma', 'robo', 'donacion', 'salida_ajuste')
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  ),
  -- Consumo teórico: suma de salida_venta (la receta dijo X)
  teorico AS (
    SELECT
      im.insumo_id,
      SUM(ABS(im.cantidad)) AS cantidad,
      SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, 0)) AS valor
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.tipo = 'salida_venta'
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  ),
  -- Costo promedio del período (para valorizar el consumo real cuando no
  -- hay movimientos de venta para tomar el costo)
  costo_prom AS (
    SELECT
      im.insumo_id,
      AVG(COALESCE(im.costo_unitario, 0)) FILTER (WHERE im.costo_unitario > 0) AS costo
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  )
  SELECT
    i.id::BIGINT,
    i.nombre,
    i.unidad,
    COALESCE(si.stock_inicial, 0)::NUMERIC,
    COALESCE(c.cantidad, 0)::NUMERIC,
    COALESCE(c.valor, 0)::NUMERIC,
    COALESCE(m.cantidad, 0)::NUMERIC,
    COALESCE(m.valor, 0)::NUMERIC,
    COALESCE(sf.stock_final, 0)::NUMERIC,
    -- consumo_real_cantidad = stock_inicial + compras - stock_final - mermas
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))::NUMERIC AS consumo_real_cantidad,
    -- valor = consumo_cantidad × costo_promedio (o costo_actual como fallback)
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))
     * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS consumo_real_valor,
    COALESCE(t.cantidad, 0)::NUMERIC AS consumo_teorico_cantidad,
    COALESCE(t.valor, 0)::NUMERIC AS consumo_teorico_valor,
    -- diferencia = real − teórico
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0))::NUMERIC AS diferencia_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
      - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS diferencia_valor,
    -- eficiencia = teorico / real × 100 (si real > 0). NULL si real = 0.
    CASE
      WHEN (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
            - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)) > 0
      THEN ROUND(
        COALESCE(t.cantidad, 0) /
        NULLIF(COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
               - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0), 0) * 100,
        2
      )
      ELSE NULL
    END AS eficiencia_pct,
    COALESCE(cp.costo, i.costo_actual, 0)::NUMERIC AS costo_promedio
  FROM insumos i
  LEFT JOIN stock_ini si ON si.insumo_id = i.id
  LEFT JOIN stock_fin sf ON sf.insumo_id = i.id
  LEFT JOIN compras c ON c.insumo_id = i.id
  LEFT JOIN mermas m ON m.insumo_id = i.id
  LEFT JOIN teorico t ON t.insumo_id = i.id
  LEFT JOIN costo_prom cp ON cp.insumo_id = i.id
  WHERE i.tenant_id = p_tenant_id
    AND (i.local_id = p_local_id OR i.local_id IS NULL)
    AND i.deleted_at IS NULL
    AND i.activo = TRUE
    -- Solo insumos con algún movimiento o stock — el resto es ruido
    AND (
      COALESCE(c.cantidad, 0) > 0 OR
      COALESCE(t.cantidad, 0) > 0 OR
      COALESCE(m.cantidad, 0) > 0 OR
      COALESCE(si.stock_inicial, 0) > 0 OR
      COALESCE(sf.stock_final, 0) > 0
    )
  ORDER BY ABS(
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0)
  ) DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cmv_real(UUID, INTEGER, DATE, DATE) TO authenticated;

-- ─── Resumen agregado: 1 fila con KPIs totales del período ────────────────
CREATE OR REPLACE FUNCTION fn_cmv_real_resumen(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
) RETURNS TABLE (
  consumo_real_valor NUMERIC,
  consumo_teorico_valor NUMERIC,
  compras_valor NUMERIC,
  mermas_valor NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  -- Cantidad de insumos con diferencia "significativa" (>5% del real)
  insumos_con_fuga INTEGER,
  -- Ventas del período (para calcular CMV % sobre facturación)
  facturacion NUMERIC,
  cmv_real_pct NUMERIC,
  cmv_teorico_pct NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facturacion NUMERIC;
BEGIN
  -- Facturación del período (suma de ventas no anuladas)
  SELECT COALESCE(SUM(total), 0) INTO v_facturacion
    FROM ventas_pos
   WHERE local_id = p_local_id
     AND tenant_id = p_tenant_id
     AND fecha::DATE BETWEEN p_desde AND p_hasta
     AND estado = 'cobrada'
     AND deleted_at IS NULL;

  RETURN QUERY
  WITH detalle AS (
    SELECT * FROM fn_cmv_real(p_tenant_id, p_local_id, p_desde, p_hasta)
  )
  SELECT
    COALESCE(SUM(d.consumo_real_valor), 0)::NUMERIC AS consumo_real_valor,
    COALESCE(SUM(d.consumo_teorico_valor), 0)::NUMERIC AS consumo_teorico_valor,
    COALESCE(SUM(d.compras_valor), 0)::NUMERIC AS compras_valor,
    COALESCE(SUM(d.mermas_valor), 0)::NUMERIC AS mermas_valor,
    COALESCE(SUM(d.diferencia_valor), 0)::NUMERIC AS diferencia_valor,
    CASE
      WHEN SUM(d.consumo_real_valor) > 0
      THEN ROUND(SUM(d.consumo_teorico_valor) / NULLIF(SUM(d.consumo_real_valor), 0) * 100, 2)
      ELSE NULL
    END AS eficiencia_pct,
    COUNT(*) FILTER (
      WHERE d.diferencia_cantidad < 0
        AND ABS(d.diferencia_cantidad) > 0.05 * GREATEST(d.consumo_real_cantidad, 0.001)
    )::INTEGER AS insumos_con_fuga,
    v_facturacion AS facturacion,
    CASE
      WHEN v_facturacion > 0
      THEN ROUND(SUM(d.consumo_real_valor) / v_facturacion * 100, 2)
      ELSE NULL
    END AS cmv_real_pct,
    CASE
      WHEN v_facturacion > 0
      THEN ROUND(SUM(d.consumo_teorico_valor) / v_facturacion * 100, 2)
      ELSE NULL
    END AS cmv_teorico_pct
  FROM detalle d;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cmv_real_resumen(UUID, INTEGER, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
