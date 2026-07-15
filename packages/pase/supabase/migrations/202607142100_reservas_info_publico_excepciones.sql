-- ═══════════════════════════════════════════════════════════════════════════
-- MESA reservas: exponer las EXCEPCIONES (días especiales) a la página pública.
--
-- Contexto: la migración 202607142000 hizo que el motor (fn_check_disponibilidad
-- _reserva / fn_slots_disponibilidad_publico) respete las excepciones por fecha.
-- PERO la página pública de reservas arma el calendario y los turnos en el
-- CLIENTE, usando SOLO el horario semanal (info.horarios) → un día abierto por
-- excepción (ej. un lunes que normalmente cierra) quedaba deshabilitado en el
-- calendario y sin turnos, aunque el backend sí lo permitía.
--
-- El público es anon y NO puede leer reservas_excepciones (RLS authenticated).
-- Solución: fn_get_reservas_info_publico (SECURITY DEFINER) devuelve también las
-- excepciones de la ventana de reservas [hoy, hoy+anticipacion_max_dias], para
-- que el cliente habilite/deshabilite cada FECHA y genere los turnos correctos.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS fn_get_reservas_info_publico(text);

CREATE OR REPLACE FUNCTION fn_get_reservas_info_publico(p_local_slug TEXT)
RETURNS TABLE (
  local_id INTEGER,
  local_nombre TEXT,
  activas BOOLEAN,
  capacidad_max INTEGER,
  anticipacion_min_hs INTEGER,
  anticipacion_max_dias INTEGER,
  duracion_estimada_min INTEGER,
  horarios JSONB,
  telefono_obligatorio BOOLEAN,
  notas_publicas TEXT,
  requiere_confirmacion BOOLEAN,
  -- NUEVO: excepciones por fecha en la ventana de reservas. Array de
  -- { fecha:'YYYY-MM-DD', cerrado:bool, abre:'HH:MI'|null, cierra:'HH:MI'|null }.
  excepciones JSONB
) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    cls.local_id,
    l.nombre,
    cls.reservas_activas,
    COALESCE(cls.reservas_capacidad_max, 50),
    cls.reservas_anticipacion_min_hs,
    cls.reservas_anticipacion_max_dias,
    cls.reservas_duracion_estimada_min,
    COALESCE(cls.reservas_horarios, '[]'::jsonb),
    cls.reservas_telefono_obligatorio,
    cls.reservas_notas_visibles_cliente,
    cls.reservas_requiere_confirmacion,
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'fecha',   e.fecha,
                 'cerrado', e.cerrado,
                 'abre',    to_char(e.abre,   'HH24:MI'),
                 'cierra',  to_char(e.cierra, 'HH24:MI')
               ) ORDER BY e.fecha)
      FROM reservas_excepciones e
      WHERE e.local_id = cls.local_id
        AND e.fecha >= (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
        AND e.fecha <= (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
                       + COALESCE(cls.reservas_anticipacion_max_dias, 30)
    ), '[]'::jsonb)
  FROM comanda_local_settings cls
  INNER JOIN locales l ON l.id = cls.local_id
  WHERE cls.slug = p_local_slug
    AND cls.tienda_activa = TRUE
    AND cls.deleted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_get_reservas_info_publico(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_get_reservas_info_publico(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
