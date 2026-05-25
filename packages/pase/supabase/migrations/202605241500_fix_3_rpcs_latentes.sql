-- ─────────────────────────────────────────────────────────────────────────
-- Fix 3 RPCs latentes detectadas por análisis defensivo 24-may noche
-- ─────────────────────────────────────────────────────────────────────────
--
-- Sesión de auditoría post-fix-marketplace: corrí TODOS los RPCs públicos
-- con RETURNS TABLE pasándoles args dummy + tipo-compatibles para detectar
-- errores de schema (no de input/business logic). 40 RPCs testeados, 3
-- bugs reales encontrados, todos en producción desde hace meses:
--
--   1. fn_crear_delivery_rider           — `l.deleted_at` no existe
--   2. fn_crear_print_agent_token        — `l.deleted_at` no existe
--   3. fn_reporte_menu_engineering_comanda — `cantidad_vendida` ambiguous
--
-- Impacto operativo:
--   1+2: nunca se pudo crear un rider de delivery ni un agente de impresión
--        desde la app — silenciosamente roto. Como nadie usaba estas
--        features todavía (Lucas no tiene riders ni printers conectados),
--        no se notaba.
--   3: el reporte de Menu Engineering (clasificación star/plowhorse/puzzle/
--      dog estilo Kasavana-Smith) en COMANDA jamás funcionó. Cualquier
--      cliente que hiciera click en el reporte recibía error.
--
-- Causa raíz:
--   1+2: las RPCs asumen que `locales` tiene soft-delete (`deleted_at`)
--        pero la tabla nunca lo tuvo. Probablemente copy-paste de otra RPC
--        cuya tabla sí lo tenía.
--   3:   misma clase de bug que rompió el marketplace 3 semanas — la
--        columna OUT de RETURNS TABLE `cantidad_vendida` colisiona con
--        la columna del CTE `items_vendidos.cantidad_vendida` cuando se
--        usa en `PERCENTILE_CONT(... WITHIN GROUP (ORDER BY ...))`.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── FIX 1: fn_crear_delivery_rider ───────────────────────────────────────
-- Quitar `AND l.deleted_at IS NULL` — locales no tiene esa columna.
CREATE OR REPLACE FUNCTION public.fn_crear_delivery_rider(
  p_local_id INTEGER,
  p_nombre TEXT,
  p_telefono TEXT DEFAULT NULL,
  p_foto_url TEXT DEFAULT NULL
)
RETURNS TABLE(rider_id BIGINT, rider_token TEXT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_token TEXT;
  v_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- FIX 2026-05-24: locales NO tiene deleted_at. Antes fallaba siempre
  -- con "column l.deleted_at does not exist".
  IF NOT EXISTS (
    SELECT 1 FROM locales l
     WHERE l.id = p_local_id AND l.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF p_nombre IS NULL OR length(trim(p_nombre)) = 0 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO delivery_riders (tenant_id, local_id, rider_token, nombre, telefono, foto_url)
  VALUES (
    v_tenant_id, p_local_id, v_token,
    trim(p_nombre),
    NULLIF(trim(p_telefono), ''),
    NULLIF(trim(p_foto_url), '')
  )
  RETURNING delivery_riders.id INTO v_id;

  RETURN QUERY SELECT v_id AS rider_id, v_token AS rider_token;
END;
$$;

-- ─── FIX 2: fn_crear_print_agent_token ────────────────────────────────────
-- Mismo bug: `l.deleted_at` no existe.
CREATE OR REPLACE FUNCTION public.fn_crear_print_agent_token(
  p_local_id INTEGER,
  p_nombre TEXT DEFAULT 'PC sin nombre'
)
RETURNS TABLE(agent_id BIGINT, agent_token TEXT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_token TEXT;
  v_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  -- FIX 2026-05-24: locales NO tiene deleted_at.
  IF NOT EXISTS (
    SELECT 1 FROM locales l
     WHERE l.id = p_local_id AND l.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO comanda_print_agents (tenant_id, local_id, agent_token, nombre)
  VALUES (v_tenant_id, p_local_id, v_token, COALESCE(NULLIF(trim(p_nombre), ''), 'PC sin nombre'))
  RETURNING comanda_print_agents.id INTO v_id;

  RETURN QUERY SELECT v_id AS agent_id, v_token AS agent_token;
END;
$$;

-- ─── FIX 3: fn_reporte_menu_engineering_comanda ───────────────────────────
-- `cantidad_vendida` ambiguous: la columna OUT colisiona con la del CTE.
-- Fix: renombrar la columna interna del CTE a `cantidad_vendida_calc` y
-- mantener `cantidad_vendida` solo como alias del SELECT final que mapea
-- al OUT.
CREATE OR REPLACE FUNCTION public.fn_reporte_menu_engineering_comanda(
  p_local_id INTEGER,
  p_desde TIMESTAMPTZ,
  p_hasta TIMESTAMPTZ
)
RETURNS TABLE(
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
LANGUAGE plpgsql SECURITY DEFINER
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
      i.id AS item_id_calc,
      i.nombre AS nombre_calc,
      i.emoji AS emoji_calc,
      -- FIX 2026-05-24: renombro las columnas internas con sufijo _calc
      -- para evitar colisión con las columnas de RETURNS TABLE.
      SUM(vpi.cantidad)::NUMERIC AS cantidad_vendida_calc,
      SUM(vpi.subtotal)::NUMERIC AS total_facturado_calc,
      AVG(vpi.precio_unitario)::NUMERIC AS precio_promedio_calc,
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
    INNER JOIN ventas_pos v ON v.id = vpi.venta_id
    INNER JOIN items i ON i.id = vpi.item_id
    WHERE v.local_id = p_local_id
      AND v.estado = 'cobrada'
      AND v.cobrada_at BETWEEN p_desde AND p_hasta
      AND v.deleted_at IS NULL
      AND vpi.deleted_at IS NULL
      AND vpi.estado <> 'anulado'
      AND i.deleted_at IS NULL
    GROUP BY i.id, i.nombre, i.emoji
  ),
  con_margenes AS (
    SELECT
      iv.item_id_calc,
      iv.nombre_calc,
      iv.emoji_calc,
      iv.cantidad_vendida_calc,
      iv.total_facturado_calc,
      iv.precio_promedio_calc,
      iv.costo_porcion_calc,
      CASE
        WHEN iv.costo_porcion_calc IS NOT NULL
        THEN iv.precio_promedio_calc - iv.costo_porcion_calc
        ELSE NULL
      END AS margen_unitario_calc,
      CASE
        WHEN iv.costo_porcion_calc IS NOT NULL AND iv.precio_promedio_calc > 0
        THEN ((iv.precio_promedio_calc - iv.costo_porcion_calc) / iv.precio_promedio_calc) * 100
        ELSE NULL
      END AS margen_pct_calc
    FROM items_vendidos iv
  ),
  medianas AS (
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cm.cantidad_vendida_calc) AS mediana_pop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cm.margen_pct_calc) AS mediana_margen
    FROM con_margenes cm
    WHERE cm.costo_porcion_calc IS NOT NULL
  )
  SELECT
    cm.item_id_calc AS item_id,
    cm.nombre_calc AS nombre,
    cm.emoji_calc AS emoji,
    cm.cantidad_vendida_calc AS cantidad_vendida,
    cm.total_facturado_calc AS total_facturado,
    cm.precio_promedio_calc AS precio_promedio,
    cm.costo_porcion_calc AS costo_porcion,
    cm.margen_unitario_calc AS margen_unitario,
    cm.margen_pct_calc AS margen_pct,
    CASE
      WHEN cm.costo_porcion_calc IS NULL THEN 'sin_receta'
      WHEN med.mediana_pop IS NULL OR med.mediana_margen IS NULL THEN 'sin_clasificar'
      WHEN cm.cantidad_vendida_calc >= med.mediana_pop AND cm.margen_pct_calc >= med.mediana_margen THEN 'star'
      WHEN cm.cantidad_vendida_calc >= med.mediana_pop AND cm.margen_pct_calc <  med.mediana_margen THEN 'plowhorse'
      WHEN cm.cantidad_vendida_calc <  med.mediana_pop AND cm.margen_pct_calc >= med.mediana_margen THEN 'puzzle'
      ELSE 'dog'
    END AS cuadrante
  FROM con_margenes cm
  CROSS JOIN medianas med
  ORDER BY cm.cantidad_vendida_calc DESC;
END;
$$;

COMMENT ON FUNCTION public.fn_reporte_menu_engineering_comanda IS
  'Reporte clasificación Menu Engineering (star/plowhorse/puzzle/dog) según '
  'cantidad vendida y margen %. Fix 2026-05-24: renombrar columnas internas '
  'de CTE con sufijo _calc para evitar colisión con OUT del RETURNS TABLE.';
