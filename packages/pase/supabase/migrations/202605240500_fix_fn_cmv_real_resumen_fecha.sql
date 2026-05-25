-- ─────────────────────────────────────────────────────────────────────────
-- Fix bug fn_cmv_real_resumen — columna 'fecha' no existe en ventas_pos
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug descubierto 2026-05-24 corriendo test E2E end-to-end de la cadena
-- compras → stock → recetas → ventas → CMV. La RPC fallaba con:
--   "column 'fecha' does not exist"
--
-- Causa: migrations 202605211500_cmv_real.sql:256 y
-- 202605212200_auditoria_criticos.sql:256 filtran por `fecha::DATE`, pero
-- ventas_pos NO tiene columna `fecha` — la fecha contable de una venta
-- cobrada es `cobrada_at` (consistente con migrations cmv_optimizado y
-- cmv_reporte que ya usan v.cobrada_at::DATE).
--
-- Impacto: la pantalla de CMV Real en producción siempre devolvía error,
-- nadie pudo ver el reporte de Costo de Mercadería Vendida real desde
-- que se mergeó la auditoría crítica (21-may).
--
-- Fix: cambiar `fecha::DATE` por `cobrada_at::DATE` en el SELECT de
-- facturación dentro de fn_cmv_real_resumen.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cmv_real_resumen(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
)
RETURNS TABLE (
  consumo_real_valor NUMERIC,
  consumo_teorico_valor NUMERIC,
  compras_valor NUMERIC,
  mermas_valor NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  insumos_con_fuga INTEGER,
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
  -- CRIT-3: validar que el tenant solicitado sea el del caller
  -- (superadmin puede cruzar tenants para reportes ecosistémicos).
  IF p_tenant_id IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_facturacion
    FROM ventas_pos
   WHERE local_id = p_local_id
     AND tenant_id = p_tenant_id
     AND cobrada_at::DATE BETWEEN p_desde AND p_hasta   -- FIX: era `fecha::DATE`, columna inexistente
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

COMMENT ON FUNCTION public.fn_cmv_real_resumen(UUID, INTEGER, DATE, DATE) IS
  'Resumen agregado del CMV real para un local en un rango. Fix 2026-05-24: '
  'filtra ventas por cobrada_at (no `fecha` que no existe).';
