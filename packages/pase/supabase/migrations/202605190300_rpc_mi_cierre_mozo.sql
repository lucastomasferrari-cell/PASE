-- ═══════════════════════════════════════════════════════════════════════════
-- fn_mi_cierre_mozo — shift report del mozo logueado para el día actual
-- Sesión 2026-05-18 (roadmap A4.3)
--
-- Cada mozo / cajero al terminar su turno necesita ver:
--   - Cuántas ventas cobró
--   - Total por método (efectivo / crédito / débito / QR / etc.)
--   - Cuotas si aplica (efectivo ARS, no nominal)
--   - Cantidad de items movidos (opcional, futuro)
--
-- Approach pragmático: NO tabla materializada ni trigger nuevo. Calcula
-- on-demand desde ventas_pos_pagos filtrando por cobrado_por + fecha.
-- Si el volumen crece (1000+ ventas/día), considerar materializar.
--
-- Permisos: anyone authenticated puede llamar la RPC con su propio
-- empleado_id. Para ver el shift de OTRO mozo se requiere manager o dueño.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_mi_cierre_mozo(
  p_empleado_id UUID,
  p_fecha_desde TIMESTAMPTZ DEFAULT NULL,
  p_fecha_hasta TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
  ventas_cobradas BIGINT,
  total_cobrado NUMERIC,
  efectivo NUMERIC,
  credito NUMERIC,
  credito_cuotas BIGINT,
  debito NUMERIC,
  qr NUMERIC,
  transferencia NUMERIC,
  otros NUMERIC,
  primer_cobro TIMESTAMPTZ,
  ultimo_cobro TIMESTAMPTZ,
  mesas_atendidas BIGINT,
  ticket_promedio NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_desde TIMESTAMPTZ := COALESCE(p_fecha_desde, date_trunc('day', NOW()));
  v_hasta TIMESTAMPTZ := COALESCE(p_fecha_hasta, NOW());
  v_caller_uid UUID := auth.uid();
  v_caller_empleado_id UUID;
BEGIN
  IF auth_usuario_id() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  -- Caller debe ser el empleado dueño del cierre, O un manager/dueño/admin.
  -- empleado.auth_id = auth.uid() match — el empleado pos vive con auth_id
  -- vinculado al usuario.
  SELECT id INTO v_caller_empleado_id
  FROM rrhh_empleados
  WHERE id = p_empleado_id AND tenant_id = auth_tenant_id();
  IF v_caller_empleado_id IS NULL THEN
    RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO_O_OTRO_TENANT';
  END IF;

  -- Si NO es dueño/admin, verificar que el empleado_id sea el del caller.
  IF NOT auth_es_dueno_o_admin() THEN
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados emp
      JOIN usuarios u ON u.id = auth_usuario_id()
      WHERE emp.id = p_empleado_id
        AND emp.email = u.email
    ) THEN
      RAISE EXCEPTION 'NO_AUTORIZADO_PARA_VER_OTRO_MOZO';
    END IF;
  END IF;

  RETURN QUERY
  WITH pagos_filtrados AS (
    SELECT
      p.monto,
      p.metodo,
      p.cuotas,
      p.confirmado_at,
      p.venta_id,
      v.mesa_id
    FROM ventas_pos_pagos p
    JOIN ventas_pos v ON v.id = p.venta_id
    WHERE p.cobrado_por = p_empleado_id
      AND p.estado = 'confirmado'
      AND p.confirmado_at >= v_desde
      AND p.confirmado_at <= v_hasta
  )
  SELECT
    COUNT(DISTINCT venta_id)::BIGINT AS ventas_cobradas,
    COALESCE(SUM(monto), 0)::NUMERIC AS total_cobrado,
    COALESCE(SUM(monto) FILTER (WHERE lower(metodo) LIKE '%efectivo%'), 0)::NUMERIC AS efectivo,
    COALESCE(SUM(monto) FILTER (WHERE lower(metodo) LIKE '%credit%' OR lower(metodo) = 'tc'), 0)::NUMERIC AS credito,
    COUNT(*) FILTER (WHERE cuotas IS NOT NULL AND cuotas > 1)::BIGINT AS credito_cuotas,
    COALESCE(SUM(monto) FILTER (WHERE lower(metodo) LIKE '%debit%' OR lower(metodo) = 'td'), 0)::NUMERIC AS debito,
    COALESCE(SUM(monto) FILTER (WHERE lower(metodo) LIKE '%qr%'), 0)::NUMERIC AS qr,
    COALESCE(SUM(monto) FILTER (WHERE lower(metodo) LIKE '%transfer%'), 0)::NUMERIC AS transferencia,
    COALESCE(SUM(monto) FILTER (WHERE
      lower(metodo) NOT LIKE '%efectivo%' AND
      lower(metodo) NOT LIKE '%credit%' AND lower(metodo) != 'tc' AND
      lower(metodo) NOT LIKE '%debit%' AND lower(metodo) != 'td' AND
      lower(metodo) NOT LIKE '%qr%' AND
      lower(metodo) NOT LIKE '%transfer%'
    ), 0)::NUMERIC AS otros,
    MIN(confirmado_at) AS primer_cobro,
    MAX(confirmado_at) AS ultimo_cobro,
    COUNT(DISTINCT mesa_id) FILTER (WHERE mesa_id IS NOT NULL)::BIGINT AS mesas_atendidas,
    CASE
      WHEN COUNT(DISTINCT venta_id) > 0
      THEN (COALESCE(SUM(monto), 0) / COUNT(DISTINCT venta_id))::NUMERIC
      ELSE 0::NUMERIC
    END AS ticket_promedio
  FROM pagos_filtrados;

  -- Si no hay datos, devolver una fila con ceros
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::BIGINT, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 0::BIGINT, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 0::BIGINT, 0::NUMERIC;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_mi_cierre_mozo(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mi_cierre_mozo(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';
