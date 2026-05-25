-- ─────────────────────────────────────────────────────────────────────────
-- fn_par_level_forecast: calculador de compras sugeridas (par-level)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Implementa el ticket "🛒 Calculador de compras semanal / Par-level
-- forecast" anotado el 24-may noche por Lucas. En la industria gastro
-- se llama "par level calculation" (Toast/R365/MarginEdge lo tienen
-- bajo este nombre).
--
-- Concepto: para cada insumo, calcula cuánto comprar para que aguante
-- N días al ritmo de venta promedio histórico, considerando un safety
-- stock para imprevistos.
--
-- Fórmula:
--   uso_diario = SUM(consumo de últimos N_dias_historia) / N_dias_historia
--   cantidad_a_comprar = ceil(
--     (uso_diario × dias_horizonte × (1 + safety_stock_pct/100))
--     - stock_actual
--   )
--
-- Si el resultado es ≤ 0, no hace falta comprar (stock alcanza).
--
-- Inputs:
--   p_tenant_id              UUID — tenant del operador (validado vs auth)
--   p_local_id               INTEGER — local específico
--   p_dias_horizonte         INTEGER DEFAULT 7 — días que querés cubrir
--   p_safety_stock_pct       NUMERIC DEFAULT 20 — % de buffer
--   p_dias_historia          INTEGER DEFAULT 28 — ventana para promediar
--
-- Output: tabla con todos los insumos del local + datos de forecast.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_par_level_forecast(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_dias_horizonte INTEGER DEFAULT 7,
  p_safety_stock_pct NUMERIC DEFAULT 20,
  p_dias_historia INTEGER DEFAULT 28
)
RETURNS TABLE(
  insumo_id BIGINT,
  insumo_nombre TEXT,
  unidad TEXT,
  categoria_pl TEXT,
  stock_actual NUMERIC,
  costo_actual NUMERIC,
  uso_diario_promedio NUMERIC,
  uso_semanal_promedio NUMERIC,
  uso_mensual_promedio NUMERIC,
  dias_aguanta NUMERIC,
  cantidad_sugerida NUMERIC,
  costo_estimado_compra NUMERIC,
  proveedor_preferido_id INTEGER,
  proveedor_preferido_nombre TEXT,
  estado_urgencia TEXT,
  datos_insuficientes BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_historia INTEGER := 14;  -- requiere al menos 14d de historia para confiar
BEGIN
  -- Auth check: tenant del caller debe coincidir (superadmin bypasa).
  IF p_tenant_id IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  -- Permission check: dueño/admin O encargado del local.
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_dias_horizonte <= 0 OR p_dias_horizonte > 60 THEN
    RAISE EXCEPTION 'HORIZONTE_INVALIDO: debe estar entre 1 y 60 días';
  END IF;
  IF p_safety_stock_pct < 0 OR p_safety_stock_pct > 100 THEN
    RAISE EXCEPTION 'SAFETY_STOCK_INVALIDO: debe estar entre 0 y 100';
  END IF;

  RETURN QUERY
  WITH consumo_historico AS (
    -- Suma del consumo (salida_venta + mermas) de los últimos N días.
    -- Solo cuenta movs NO anulados. SUM negativo porque las salidas son
    -- importes negativos en insumo_movimientos.
    SELECT
      im.insumo_id,
      (-SUM(im.cantidad)) AS total_consumido,
      COUNT(DISTINCT DATE(im.created_at)) AS dias_con_movimiento
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.tipo IN ('salida_venta', 'merma', 'robo', 'donacion', 'salida_ajuste')
      AND im.created_at > (now() - (p_dias_historia || ' days')::INTERVAL)
      AND COALESCE(im.deleted_at, NULL) IS NULL
    GROUP BY im.insumo_id
  ),
  proveedor_lookup AS (
    -- Mapeo insumo → proveedor preferido (vía materias_primas).
    -- Si hay múltiples MP por insumo, agarra la primera activa.
    SELECT DISTINCT ON (mp.insumo_id)
      mp.insumo_id,
      mp.proveedor_id,
      p.nombre AS proveedor_nombre
    FROM materias_primas mp
    LEFT JOIN proveedores p ON p.id = mp.proveedor_id
    WHERE mp.tenant_id = p_tenant_id
      AND mp.activa = TRUE
      AND COALESCE(mp.deleted_at, NULL) IS NULL
    ORDER BY mp.insumo_id, mp.id
  )
  SELECT
    i.id::BIGINT,
    i.nombre,
    i.unidad,
    i.categoria_pl,
    COALESCE(i.stock_actual, 0)::NUMERIC,
    COALESCE(i.costo_actual, 0)::NUMERIC,
    -- Uso diario promedio
    COALESCE(ch.total_consumido / GREATEST(p_dias_historia, 1)::NUMERIC, 0) AS uso_diario_promedio,
    -- Uso semanal y mensual derivados
    COALESCE(ch.total_consumido / GREATEST(p_dias_historia, 1)::NUMERIC, 0) * 7 AS uso_semanal_promedio,
    COALESCE(ch.total_consumido / GREATEST(p_dias_historia, 1)::NUMERIC, 0) * 30 AS uso_mensual_promedio,
    -- Días que aguanta = stock_actual / uso_diario
    CASE
      WHEN COALESCE(ch.total_consumido, 0) > 0 AND COALESCE(i.stock_actual, 0) > 0
      THEN ROUND(i.stock_actual / (ch.total_consumido / p_dias_historia::NUMERIC), 1)
      ELSE NULL
    END AS dias_aguanta,
    -- Cantidad sugerida a comprar
    CASE
      WHEN COALESCE(ch.dias_con_movimiento, 0) < (v_min_historia / 7) THEN 0  -- sin historia
      ELSE GREATEST(
        0,
        CEIL(
          (ch.total_consumido / GREATEST(p_dias_historia, 1)::NUMERIC)
          * p_dias_horizonte
          * (1 + p_safety_stock_pct / 100.0)
          - COALESCE(i.stock_actual, 0)
        )
      )
    END AS cantidad_sugerida,
    -- Costo estimado total de la compra sugerida
    CASE
      WHEN COALESCE(ch.dias_con_movimiento, 0) < (v_min_historia / 7) THEN 0
      ELSE GREATEST(
        0,
        CEIL(
          (ch.total_consumido / GREATEST(p_dias_historia, 1)::NUMERIC)
          * p_dias_horizonte
          * (1 + p_safety_stock_pct / 100.0)
          - COALESCE(i.stock_actual, 0)
        ) * COALESCE(i.costo_actual, 0)
      )
    END AS costo_estimado_compra,
    pl.proveedor_id::INTEGER,
    pl.proveedor_nombre,
    -- Estado de urgencia (semáforo)
    CASE
      WHEN COALESCE(ch.dias_con_movimiento, 0) < (v_min_historia / 7) THEN 'sin_datos'
      WHEN COALESCE(i.stock_actual, 0) <= 0 THEN 'agotado'
      WHEN COALESCE(ch.total_consumido, 0) <= 0 THEN 'sin_movimiento'
      WHEN (i.stock_actual / (ch.total_consumido / p_dias_historia::NUMERIC)) < 2 THEN 'urgente'
      WHEN (i.stock_actual / (ch.total_consumido / p_dias_historia::NUMERIC)) < 7 THEN 'pronto'
      ELSE 'ok'
    END AS estado_urgencia,
    -- Flag de datos insuficientes (para UI mostrar "?" en lugar de número)
    COALESCE(ch.dias_con_movimiento, 0) < (v_min_historia / 7) AS datos_insuficientes
  FROM insumos i
  LEFT JOIN consumo_historico ch ON ch.insumo_id = i.id
  LEFT JOIN proveedor_lookup pl ON pl.insumo_id = i.id
  WHERE i.tenant_id = p_tenant_id
    AND (i.local_id = p_local_id OR i.local_id IS NULL)
    AND i.deleted_at IS NULL
    AND i.activo = TRUE
    AND COALESCE(i.es_comprado, TRUE) = TRUE  -- solo insumos comprados (no producidos)
  ORDER BY
    -- Primero los urgentes, después los próximos, después OK, último sin datos
    CASE
      WHEN COALESCE(ch.dias_con_movimiento, 0) < (v_min_historia / 7) THEN 5
      WHEN COALESCE(i.stock_actual, 0) <= 0 THEN 1
      WHEN COALESCE(ch.total_consumido, 0) <= 0 THEN 4
      WHEN (i.stock_actual / (ch.total_consumido / p_dias_historia::NUMERIC)) < 2 THEN 2
      WHEN (i.stock_actual / (ch.total_consumido / p_dias_historia::NUMERIC)) < 7 THEN 3
      ELSE 4
    END,
    i.nombre;
END;
$$;

COMMENT ON FUNCTION public.fn_par_level_forecast IS
  'Calculador de compras sugeridas (par-level forecast). Para cada insumo: '
  'analiza consumo de últimos N días, calcula uso diario/semanal/mensual, '
  'sugiere cuánto comprar para cubrir N días con safety stock %. Patrón '
  'Toast/R365/MarginEdge. Filtra solo insumos comprados (no producidos).';
