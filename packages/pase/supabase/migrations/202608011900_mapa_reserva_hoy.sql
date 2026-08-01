-- Mapa de mesas: marcar reservas de MÁS TARDE HOY, no solo las inminentes (01-ago)
-- ---------------------------------------------------------------------------
-- Pedido (Camilo): el mapa de mesas solo pintaba una mesa como reservada si la
-- reserva era en los próximos 90 min (ventana -15/+90). Las reservas de la noche
-- (20:00+) no se veían a la tarde → "no se trasladan al mapa" y no se podía ver
-- qué mesas quedaban libres para la noche.
--
-- Fix: se agrega el estado 'reservada_hoy' = mesa con una reserva pendiente/
-- confirmada MÁS TARDE HOY (más allá de la ventana "pronto"). El mapa ahora
-- distingue: libre / reservada_hoy (más tarde) / reservada_pronto (inminente) /
-- ocupada_reserva (sentada) / ocupada_ticket (COMANDA, que el front de MESA
-- ignora). 'hoy' = mismo día en hora Argentina.

CREATE OR REPLACE FUNCTION public.fn_estado_mesas_live(p_local_id integer)
 RETURNS TABLE(mesa_id bigint, estado_live text, venta_id bigint, venta_total numeric, venta_abierta_at timestamp with time zone, reserva_id bigint, reserva_nombre text, reserva_hora timestamp with time zone, reserva_personas integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    m.id::BIGINT                                          AS mesa_id,
    CASE
      WHEN t.id  IS NOT NULL THEN 'ocupada_ticket'
      WHEN rs.id IS NOT NULL THEN 'ocupada_reserva'
      WHEN rp.id IS NOT NULL THEN 'reservada_pronto'
      WHEN rh.id IS NOT NULL THEN 'reservada_hoy'
      ELSE 'libre'
    END                                                   AS estado_live,
    t.id::BIGINT                                          AS venta_id,
    t.total::NUMERIC                                      AS venta_total,
    t.abierta_at                                          AS venta_abierta_at,
    COALESCE(rs.id, rp.id, rh.id)::BIGINT                 AS reserva_id,
    COALESCE(rs.cliente_nombre, rp.cliente_nombre, rh.cliente_nombre) AS reserva_nombre,
    COALESCE(rs.fecha_hora,    rp.fecha_hora,    rh.fecha_hora)       AS reserva_hora,
    COALESCE(rs.personas,      rp.personas,      rh.personas)         AS reserva_personas
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
  -- Reserva más tarde HOY (después de la ventana "pronto") — la más próxima
  LEFT JOIN LATERAL (
    SELECT r.id, r.cliente_nombre, r.fecha_hora, r.personas
      FROM reservas r
     WHERE r.mesa_id    = m.id
       AND r.local_id   = p_local_id
       AND r.estado     IN ('pendiente', 'confirmada')
       AND r.deleted_at IS NULL
       AND r.fecha_hora > NOW() + INTERVAL '90 minutes'
       AND (r.fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
         = (NOW()        AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
     ORDER BY r.fecha_hora ASC
     LIMIT 1
  ) rh ON TRUE
  WHERE m.local_id   = p_local_id
    AND m.deleted_at IS NULL
  ORDER BY m.zona NULLS LAST, m.id;
$function$;
