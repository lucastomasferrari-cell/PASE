-- ═══════════════════════════════════════════════════════════════════════════
-- RPC fn_reporte_performance_empleados_comanda
-- ═══════════════════════════════════════════════════════════════════════════
-- Devuelve performance por cajero del local en el rango: cantidad de ventas
-- cobradas, total facturado, ticket promedio, total propinas. Útil para
-- evaluar cajeros y detectar desbalances (un cajero que vende 3x el resto,
-- o uno que cobra poco — posible signo de fraude).

DROP FUNCTION IF EXISTS fn_reporte_performance_empleados_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION fn_reporte_performance_empleados_comanda(
  p_local_id INTEGER,
  p_desde TIMESTAMPTZ,
  p_hasta TIMESTAMPTZ
) RETURNS TABLE (
  empleado_id UUID,
  empleado_nombre TEXT,
  rol_pos TEXT,
  cantidad_ventas BIGINT,
  total_facturado NUMERIC,
  ticket_promedio NUMERIC,
  total_propinas NUMERIC,
  total_descuentos NUMERIC,
  total_anuladas NUMERIC,
  cantidad_anuladas BIGINT
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
  SELECT
    e.id AS empleado_id,
    CONCAT(COALESCE(e.apellido, ''), ' ', COALESCE(e.nombre, ''))::TEXT AS empleado_nombre,
    e.rol_pos::TEXT,
    COUNT(v.id) FILTER (WHERE v.estado = 'cobrada')::BIGINT AS cantidad_ventas,
    COALESCE(SUM(v.total) FILTER (WHERE v.estado = 'cobrada'), 0)::NUMERIC AS total_facturado,
    COALESCE(
      SUM(v.total) FILTER (WHERE v.estado = 'cobrada')
      / NULLIF(COUNT(v.id) FILTER (WHERE v.estado = 'cobrada'), 0),
      0
    )::NUMERIC AS ticket_promedio,
    COALESCE(SUM(v.propina) FILTER (WHERE v.estado = 'cobrada'), 0)::NUMERIC AS total_propinas,
    COALESCE(SUM(v.descuento_total) FILTER (WHERE v.estado = 'cobrada'), 0)::NUMERIC AS total_descuentos,
    COALESCE(SUM(v.total) FILTER (WHERE v.estado = 'anulada'), 0)::NUMERIC AS total_anuladas,
    COUNT(v.id) FILTER (WHERE v.estado = 'anulada')::BIGINT AS cantidad_anuladas
  FROM rrhh_empleados e
  LEFT JOIN ventas_pos v ON v.cajero_id = e.id
    AND v.local_id = p_local_id
    AND v.deleted_at IS NULL
    AND v.abierta_at >= p_desde AND v.abierta_at <= p_hasta
  WHERE e.local_id = p_local_id
    AND e.activo = TRUE
    AND e.pos_activo = TRUE
  GROUP BY e.id, e.apellido, e.nombre, e.rol_pos
  HAVING COUNT(v.id) > 0
  ORDER BY total_facturado DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_performance_empleados_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
