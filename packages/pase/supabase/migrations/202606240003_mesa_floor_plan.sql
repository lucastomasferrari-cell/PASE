-- ─────────────────────────────────────────────────────────────────────────
-- MESA módulo #2 — floor plan + motor de disponibilidad en vivo
-- ─────────────────────────────────────────────────────────────────────────
--
-- A) ancho/alto en mesas para dimensiones en el plano (default 80px).
-- B) fn_estado_mesas_live(p_local_id) → estado en tiempo real de cada mesa
--    leyendo ventas_pos (tickets abiertos) + reservas (sentadas + próximas).
--    Es el motor de disponibilidad del spec MESA sección 3.1.
-- ─────────────────────────────────────────────────────────────────────────

-- A. Dimensiones del plano
ALTER TABLE mesas
  ADD COLUMN IF NOT EXISTS ancho INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS alto  INTEGER NOT NULL DEFAULT 80;

-- B. Motor de disponibilidad en vivo
-- Security: SECURITY INVOKER — la RLS existente en mesas/ventas_pos/reservas
-- controla qué filas ve el usuario autenticado. Solo authenticated puede ejecutar.
DROP FUNCTION IF EXISTS fn_estado_mesas_live(INTEGER);

CREATE FUNCTION fn_estado_mesas_live(p_local_id INTEGER)
RETURNS TABLE(
  mesa_id          BIGINT,
  estado_live      TEXT,        -- 'libre'|'ocupada_ticket'|'ocupada_reserva'|'reservada_pronto'
  venta_id         BIGINT,
  venta_total      NUMERIC,
  venta_abierta_at TIMESTAMPTZ,
  reserva_id       BIGINT,
  reserva_nombre   TEXT,
  reserva_hora     TIMESTAMPTZ,
  reserva_personas INTEGER
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    m.id::BIGINT                                          AS mesa_id,
    CASE
      WHEN t.id  IS NOT NULL THEN 'ocupada_ticket'
      WHEN rs.id IS NOT NULL THEN 'ocupada_reserva'
      WHEN rp.id IS NOT NULL THEN 'reservada_pronto'
      ELSE 'libre'
    END                                                   AS estado_live,
    t.id::BIGINT                                          AS venta_id,
    t.total::NUMERIC                                      AS venta_total,
    t.abierta_at                                          AS venta_abierta_at,
    COALESCE(rs.id, rp.id)::BIGINT                       AS reserva_id,
    COALESCE(rs.cliente_nombre, rp.cliente_nombre)        AS reserva_nombre,
    COALESCE(rs.fecha_hora,    rp.fecha_hora)             AS reserva_hora,
    COALESCE(rs.personas,      rp.personas)               AS reserva_personas
  FROM mesas m
  -- Ticket abierto en COMANDA ahora mismo
  LEFT JOIN ventas_pos t
         ON t.mesa_id    = m.id
        AND t.local_id   = p_local_id
        AND t.estado     IN ('abierta', 'enviada', 'lista', 'entregada')
        AND t.deleted_at IS NULL
  -- Reserva sentada en esta mesa
  LEFT JOIN reservas rs
         ON rs.mesa_id    = m.id
        AND rs.local_id   = p_local_id
        AND rs.estado     = 'sentada'
        AND rs.deleted_at IS NULL
  -- Reserva próxima asignada a esta mesa (ventana -15min a +90min)
  LEFT JOIN reservas rp
         ON rp.mesa_id    = m.id
        AND rp.local_id   = p_local_id
        AND rp.estado     IN ('pendiente', 'confirmada')
        AND rp.deleted_at IS NULL
        AND rp.fecha_hora BETWEEN NOW() - INTERVAL '15 minutes'
                              AND NOW() + INTERVAL '90 minutes'
  WHERE m.local_id   = p_local_id
    AND m.deleted_at IS NULL
  ORDER BY m.zona NULLS LAST, m.id;
$$;

GRANT EXECUTE ON FUNCTION fn_estado_mesas_live(INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
