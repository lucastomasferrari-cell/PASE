-- Mapa de mesas: una reserva multi-mesa se refleja en TODAS sus mesas (01-ago)
-- ---------------------------------------------------------------------------
-- Bug (Camilo): una reserva que ocupa una combinación de mesas (mesas_ids, ej.
-- [3,4]) solo pintaba la mesa principal (mesa_id) en el mapa; las demás mesas
-- de la combinación quedaban libres. Fix: una mesa se considera de la reserva si
-- es su mesa_id O está en su mesas_ids. Se aplica al conteo del día y a la
-- reserva sentada. (Reemplaza la def de 202608012000.)

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
  -- Reserva sentada AHORA en esta mesa (principal o en la combinación)
  LEFT JOIN reservas rs
         ON (rs.mesa_id = m.id OR m.id = ANY(rs.mesas_ids))
        AND rs.local_id   = p_local_id
        AND rs.estado     = 'sentada'
        AND rs.deleted_at IS NULL
  -- Reservas del día en esta mesa (principal o combinación): conteo + próxima
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS cnt,
      (array_agg(r.id             ORDER BY r.fecha_hora))[1] AS prox_id,
      (array_agg(r.cliente_nombre ORDER BY r.fecha_hora))[1] AS prox_nombre,
      (array_agg(r.fecha_hora     ORDER BY r.fecha_hora))[1] AS prox_hora,
      (array_agg(r.personas       ORDER BY r.fecha_hora))[1] AS prox_personas
    FROM reservas r
    WHERE (r.mesa_id = m.id OR m.id = ANY(r.mesas_ids))
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
