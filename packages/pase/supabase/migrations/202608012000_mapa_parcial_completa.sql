-- Mapa de mesas estilo Woki: parcial vs completa (01-ago)
-- ---------------------------------------------------------------------------
-- Pedido (Camilo, ref Woki): distinguir mesas parcialmente ocupadas (reserva en
-- un turno, libre en otro → se puede sentar a alguien) de completas (todos los
-- turnos tomados). Reemplaza el estado 'reservada_hoy' por dos:
--   · reservada_parcial  = 1 reserva hoy   (queda lugar en otro turno)
--   · reservada_completa = 2+ reservas hoy (sin lugar)
-- Se agrega la columna reservas_hoy (cuántas reservas tiene la mesa hoy) y se
-- devuelve la próxima reserva (nombre/hora/personas) para mostrar en la mesa.
-- 'ocupada_reserva' (sentada ahora) y 'ocupada_ticket' (COMANDA, que el front de
-- MESA ignora) mandan sobre el conteo.

DROP FUNCTION IF EXISTS public.fn_estado_mesas_live(integer);

CREATE FUNCTION public.fn_estado_mesas_live(p_local_id integer)
 RETURNS TABLE(mesa_id bigint, estado_live text, venta_id bigint, venta_total numeric, venta_abierta_at timestamp with time zone, reserva_id bigint, reserva_nombre text, reserva_hora timestamp with time zone, reserva_personas integer, reservas_hoy integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    m.id::BIGINT AS mesa_id,
    CASE
      WHEN t.id  IS NOT NULL          THEN 'ocupada_ticket'
      WHEN rs.id IS NOT NULL          THEN 'ocupada_reserva'
      WHEN COALESCE(rh.cnt,0) >= 2    THEN 'reservada_completa'
      WHEN COALESCE(rh.cnt,0) = 1     THEN 'reservada_parcial'
      ELSE 'libre'
    END AS estado_live,
    t.id::BIGINT AS venta_id,
    t.total::NUMERIC AS venta_total,
    t.abierta_at AS venta_abierta_at,
    COALESCE(rs.id, rh.prox_id)::BIGINT AS reserva_id,
    COALESCE(rs.cliente_nombre, rh.prox_nombre) AS reserva_nombre,
    COALESCE(rs.fecha_hora, rh.prox_hora) AS reserva_hora,
    COALESCE(rs.personas, rh.prox_personas) AS reserva_personas,
    COALESCE(rh.cnt, 0)::INTEGER AS reservas_hoy
  FROM mesas m
  -- Ticket abierto en COMANDA ahora mismo
  LEFT JOIN ventas_pos t
         ON t.mesa_id    = m.id
        AND t.local_id   = p_local_id
        AND t.estado     IN ('abierta', 'enviada', 'lista', 'entregada')
        AND t.deleted_at IS NULL
  -- Reserva sentada AHORA en esta mesa
  LEFT JOIN reservas rs
         ON rs.mesa_id    = m.id
        AND rs.local_id   = p_local_id
        AND rs.estado     = 'sentada'
        AND rs.deleted_at IS NULL
  -- Reservas del día en esta mesa: conteo + la próxima (para mostrar)
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS cnt,
      (array_agg(r.id           ORDER BY r.fecha_hora))[1] AS prox_id,
      (array_agg(r.cliente_nombre ORDER BY r.fecha_hora))[1] AS prox_nombre,
      (array_agg(r.fecha_hora   ORDER BY r.fecha_hora))[1] AS prox_hora,
      (array_agg(r.personas     ORDER BY r.fecha_hora))[1] AS prox_personas
    FROM reservas r
    WHERE r.mesa_id    = m.id
      AND r.local_id   = p_local_id
      AND r.estado     IN ('pendiente', 'confirmada')
      AND r.deleted_at IS NULL
      AND (r.fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
        = (NOW()        AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
  ) rh ON TRUE
  WHERE m.local_id   = p_local_id
    AND m.deleted_at IS NULL
  ORDER BY m.zona NULLS LAST, m.id;
$function$;
