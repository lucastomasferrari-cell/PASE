-- ============================================================
-- 202606120110_conteos_cmv_por_local.sql
-- Tier 1 #1 (informe 2026-06-11), parte 2:
-- - fn_iniciar_conteo_fisico v2: snapshotea stock_teorico desde la cache
--   per-local insumo_stock_local (antes: insumos.stock_actual global).
--   Base copiada ÍNTEGRA de la versión vigente (202605212200, CRIT-10).
-- - fn_finalizar_conteo_fisico: auditada — el INSERT del ajuste tipo='conteo'
--   YA incluye local_id (v_local_id de stock_conteos). Se recrea igual
--   (sin cambios funcionales) desde la versión VIGENTE (202605260200:
--   3 columnas de retorno incl. movs_durante + popula movs_durante_conteo).
-- - fn_cmv_real v2: stock inicial/final per-local sumando el ledger hasta
--   el borde del período (antes: snapshots globales stock_antes/stock_despues).
--   Se CONSERVA el check CRIT-3 (TENANT_MISMATCH) de la versión vigente.
-- ============================================================

BEGIN;

-- ─── Bloque 1: fn_iniciar_conteo_fisico v2 (snapshot per-local) ────────────
CREATE OR REPLACE FUNCTION fn_iniciar_conteo_fisico(
  p_local_id INTEGER,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_conteo_id BIGINT;
  v_count INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF EXISTS (
    SELECT 1 FROM stock_conteos
     WHERE local_id = p_local_id AND tenant_id = v_tenant_id AND estado = 'abierto'
  ) THEN
    RAISE EXCEPTION 'CONTEO_YA_ABIERTO';
  END IF;

  INSERT INTO stock_conteos (tenant_id, local_id, iniciado_por, notas)
  VALUES (v_tenant_id, p_local_id, auth_usuario_id(), p_notas)
  RETURNING id INTO v_conteo_id;

  -- v2: el teórico se snapshotea del LOCAL del conteo, no del global
  INSERT INTO stock_conteo_lineas (conteo_id, insumo_id, stock_teorico)
  SELECT v_conteo_id, i.id,
         COALESCE(
           (SELECT sl.cantidad FROM insumo_stock_local sl
             WHERE sl.insumo_id = i.id AND sl.local_id = p_local_id),
           0
         )
    FROM insumos i
   WHERE i.tenant_id = v_tenant_id
     AND i.activo = TRUE
     AND i.deleted_at IS NULL
     AND (i.local_id IS NULL OR i.local_id = p_local_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE stock_conteos SET total_insumos = v_count WHERE id = v_conteo_id;

  RETURN v_conteo_id;
END;
$$;
REVOKE ALL ON FUNCTION fn_iniciar_conteo_fisico(INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_iniciar_conteo_fisico(INTEGER, TEXT) TO authenticated;

-- ─── Bloque 2: fn_finalizar_conteo_fisico (auditada, sin cambios) ──────────
-- El INSERT del movimiento de ajuste tipo='conteo' ya incluye local_id
-- (v_local_id leído de stock_conteos) → con el trigger nuevo de
-- 202606120100, el ajuste impacta la cache per-local automáticamente.
-- Copia fiel de la versión vigente (202605260200). NO se repite el DROP de
-- esa migración porque el return type (3 columnas) ya coincide con el de la DB.
CREATE OR REPLACE FUNCTION public.fn_finalizar_conteo_fisico(p_conteo_id BIGINT)
RETURNS TABLE(ajustes INTEGER, diferencia_valor NUMERIC, movs_durante INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_iniciado_at TIMESTAMPTZ;
  v_ajustes INTEGER := 0;
  v_dif NUMERIC := 0;
  v_movs_durante INTEGER := 0;
  v_linea RECORD;
  v_costo NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT tenant_id, local_id, iniciado_at INTO v_tenant_id, v_local_id, v_iniciado_at
    FROM stock_conteos
   WHERE id = p_conteo_id AND estado = 'abierto';
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'CONTEO_NO_ABIERTO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Aplicar los ajustes (lógica original preservada).
  FOR v_linea IN
    SELECT l.insumo_id, l.diferencia, i.costo_actual
      FROM stock_conteo_lineas l
      INNER JOIN insumos i ON i.id = l.insumo_id
     WHERE l.conteo_id = p_conteo_id
       AND l.stock_contado IS NOT NULL
       AND l.diferencia <> 0
  LOOP
    v_costo := COALESCE(v_linea.costo_actual, 0);
    INSERT INTO insumo_movimientos (
      tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
      motivo, fuente_tipo, fuente_id, usuario_id
    ) VALUES (
      v_tenant_id, v_local_id, v_linea.insumo_id, 'conteo',
      v_linea.diferencia, v_costo,
      'Diferencia conteo físico #' || p_conteo_id,
      'conteo', p_conteo_id, auth_usuario_id()
    );
    v_ajustes := v_ajustes + 1;
    v_dif := v_dif + (v_linea.diferencia * v_costo);
  END LOOP;

  -- NUEVO 26-may: contar movs reales (no 'conteo') que ocurrieron entre
  -- iniciado_at y now(). Si > 0, el snapshot original quedó desincronizado
  -- y el ajuste aplicado puede descuadrar el stock_actual.
  SELECT COUNT(*) INTO v_movs_durante
    FROM insumo_movimientos im
   WHERE im.tenant_id = v_tenant_id
     AND im.local_id = v_local_id
     AND im.created_at BETWEEN v_iniciado_at AND now()
     AND im.tipo IN ('salida_venta', 'merma', 'robo', 'donacion', 'entrada_compra')
     AND COALESCE(im.deleted_at, NULL) IS NULL;

  UPDATE stock_conteos SET
    estado = 'finalizado',
    finalizado_at = NOW(),
    finalizado_por = auth_usuario_id(),
    total_ajustes = v_ajustes,
    valor_diferencia = v_dif,
    movs_durante_conteo = v_movs_durante  -- nuevo campo 26-may
  WHERE id = p_conteo_id;

  RETURN QUERY SELECT v_ajustes, v_dif, v_movs_durante;
END;
$$;
REVOKE ALL ON FUNCTION fn_finalizar_conteo_fisico(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_finalizar_conteo_fisico(BIGINT) TO authenticated;

-- ─── Bloque 3: fn_cmv_real v2 (per-local, sin snapshots globales) ──────────
CREATE OR REPLACE FUNCTION fn_cmv_real(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
) RETURNS TABLE (
  insumo_id BIGINT,
  insumo_nombre TEXT,
  unidad TEXT,
  stock_inicial NUMERIC,
  compras_cantidad NUMERIC,
  compras_valor NUMERIC,
  mermas_cantidad NUMERIC,
  mermas_valor NUMERIC,
  stock_final NUMERIC,
  consumo_real_cantidad NUMERIC,
  consumo_real_valor NUMERIC,
  consumo_teorico_cantidad NUMERIC,
  consumo_teorico_valor NUMERIC,
  diferencia_cantidad NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  costo_promedio NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- CRIT-3 (se conserva de la versión vigente 202605212200): validar que el
  -- tenant solicitado sea el del caller (superadmin puede cruzar tenants).
  IF p_tenant_id IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  RETURN QUERY
  WITH
  stock_ini AS (
    SELECT im.insumo_id AS iid, COALESCE(SUM(im.cantidad), 0) AS stock_inicial
      FROM insumo_movimientos im
     WHERE im.tenant_id = p_tenant_id
       AND im.local_id = p_local_id
       AND im.created_at::DATE < p_desde
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  stock_fin AS (
    SELECT im.insumo_id AS iid, COALESCE(SUM(im.cantidad), 0) AS stock_final
      FROM insumo_movimientos im
     WHERE im.tenant_id = p_tenant_id
       AND im.local_id = p_local_id
       AND im.created_at::DATE <= p_hasta
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  compras AS (
    SELECT im.insumo_id AS iid,
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
  mermas AS (
    SELECT im.insumo_id AS iid,
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
  teorico AS (
    SELECT im.insumo_id AS iid,
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
  costo_prom AS (
    SELECT im.insumo_id AS iid,
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
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))::NUMERIC AS consumo_real_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))
     * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS consumo_real_valor,
    COALESCE(t.cantidad, 0)::NUMERIC AS consumo_teorico_cantidad,
    COALESCE(t.valor, 0)::NUMERIC AS consumo_teorico_valor,
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0))::NUMERIC AS diferencia_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
      - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS diferencia_valor,
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
  LEFT JOIN stock_ini si ON si.iid = i.id
  LEFT JOIN stock_fin sf ON sf.iid = i.id
  LEFT JOIN compras c ON c.iid = i.id
  LEFT JOIN mermas m ON m.iid = i.id
  LEFT JOIN teorico t ON t.iid = i.id
  LEFT JOIN costo_prom cp ON cp.iid = i.id
  WHERE i.tenant_id = p_tenant_id
    AND (i.local_id = p_local_id OR i.local_id IS NULL)
    AND i.deleted_at IS NULL
    AND i.activo = TRUE
    AND (
      COALESCE(c.cantidad, 0) > 0 OR
      COALESCE(t.cantidad, 0) > 0 OR
      COALESCE(m.cantidad, 0) > 0 OR
      COALESCE(si.stock_inicial, 0) <> 0 OR
      COALESCE(sf.stock_final, 0) <> 0
    )
  ORDER BY ABS(
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0)
  ) DESC NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION fn_cmv_real(UUID, INTEGER, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_cmv_real(UUID, INTEGER, DATE, DATE) TO authenticated;

COMMIT;
