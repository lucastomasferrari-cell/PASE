-- ============================================================
-- Reservas: validar HORARIO de apertura en la disponibilidad pública.
--
-- Bug (detectado 1-jul, probado en vivo): el motor de disponibilidad
-- `fn_check_disponibilidad_reserva` NUNCA cruzaba `reservas_horarios`, así
-- que aceptaba reservas a cualquier hora (ej. 04:00 con el local cerrado).
-- Y los 5 locales tenían `reservas_horarios = []` (sin cargar).
--
-- Fix:
--   1. La RPC ahora respeta `reservas_horarios` (array {dia,abre,cierra},
--      dia 0=Dom..6=Sáb = EXTRACT(DOW)). Si el array está vacío → se sigue
--      aceptando cualquier horario (comportamiento documentado). Si hay
--      días cargados → rechaza CERRADO_ESE_DIA / FUERA_DE_HORARIO.
--      Soporta cierre pasada la medianoche (cierra <= abre).
--   2. Siembra horarios generosos (todos los días 11:00–23:59) en los
--      locales con reservas activas que no tenían horarios, para que el
--      4am quede bloqueado ya. Lucas ajusta los reales en la config.
--
-- `fn_crear_reserva_publica` reusa esta RPC → queda cubierto el alta también.
-- El huso se calcula en America/Argentina/Buenos_Aires.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_check_disponibilidad_reserva(
  p_local_slug text, p_fecha_hora timestamp with time zone, p_personas integer
)
RETURNS TABLE(disponible boolean, motivo text, personas_actuales integer, capacidad_max integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
  v_activas BOOLEAN;
  v_capacidad INTEGER;
  v_duracion INTEGER;
  v_anticip_min INTEGER;
  v_anticip_max INTEGER;
  v_actuales INTEGER;
  v_now TIMESTAMPTZ := NOW();
  v_dur_pedida INTEGER;
  v_horarios JSONB;
  v_local_ts TIMESTAMP;
  v_dow INTEGER;
  v_hora TIME;
  v_abre TIME;
  v_cierra TIME;
  v_dia JSONB;
  v_encontrado BOOLEAN := FALSE;
  v_en_rango BOOLEAN := FALSE;
BEGIN
  SELECT
    cls.local_id, cls.reservas_activas, COALESCE(cls.reservas_capacidad_max, 50),
    cls.reservas_duracion_estimada_min, cls.reservas_anticipacion_min_hs,
    cls.reservas_anticipacion_max_dias, COALESCE(cls.reservas_horarios, '[]'::jsonb)
  INTO v_local_id, v_activas, v_capacidad, v_duracion, v_anticip_min, v_anticip_max, v_horarios
  FROM comanda_local_settings cls
  WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'LOCAL_NO_ENCONTRADO', 0, 0; RETURN;
  END IF;
  IF NOT v_activas THEN
    RETURN QUERY SELECT FALSE, 'RESERVAS_DESACTIVADAS', 0, v_capacidad; RETURN;
  END IF;
  IF p_personas < 1 OR p_personas > 50 THEN
    RETURN QUERY SELECT FALSE, 'PERSONAS_INVALIDAS', 0, v_capacidad; RETURN;
  END IF;
  IF p_fecha_hora < v_now + (v_anticip_min || ' hours')::INTERVAL THEN
    RETURN QUERY SELECT FALSE, 'ANTICIPACION_INSUFICIENTE', 0, v_capacidad; RETURN;
  END IF;
  IF p_fecha_hora > v_now + (v_anticip_max || ' days')::INTERVAL THEN
    RETURN QUERY SELECT FALSE, 'FECHA_DEMASIADO_LEJANA', 0, v_capacidad; RETURN;
  END IF;

  -- ── Validación de HORARIO de apertura ──────────────────────────────────
  -- Solo si hay días cargados. Vacío = cualquier horario (comportamiento doc).
  IF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
    v_local_ts := p_fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_dow := EXTRACT(DOW FROM v_local_ts)::int;   -- 0=Dom .. 6=Sáb
    v_hora := v_local_ts::time;
    FOR v_dia IN SELECT * FROM jsonb_array_elements(v_horarios) LOOP
      IF (v_dia->>'dia')::int = v_dow THEN
        v_encontrado := TRUE;
        v_abre := (v_dia->>'abre')::time;
        v_cierra := (v_dia->>'cierra')::time;
        IF v_cierra > v_abre THEN
          -- Franja del mismo día.
          v_en_rango := v_hora >= v_abre AND v_hora <= v_cierra;
        ELSE
          -- Cierra pasada la medianoche (ej. 19:00–01:00).
          v_en_rango := v_hora >= v_abre OR v_hora <= v_cierra;
        END IF;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_encontrado THEN
      RETURN QUERY SELECT FALSE, 'CERRADO_ESE_DIA', 0, v_capacidad; RETURN;
    END IF;
    IF NOT v_en_rango THEN
      RETURN QUERY SELECT FALSE, 'FUERA_DE_HORARIO', 0, v_capacidad; RETURN;
    END IF;
  END IF;

  -- ── Cupo por cubiertos + solapamiento (sin cambios) ────────────────────
  v_dur_pedida := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  SELECT COALESCE(SUM(r.personas), 0) INTO v_actuales
  FROM reservas r
  WHERE r.local_id = v_local_id
    AND r.estado IN ('pendiente', 'confirmada', 'sentada')
    AND r.deleted_at IS NULL
    AND r.fecha_hora < p_fecha_hora + make_interval(mins => v_dur_pedida)
    AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, v_duracion, 90)) > p_fecha_hora;

  IF v_actuales + p_personas > v_capacidad THEN
    RETURN QUERY SELECT FALSE, 'SIN_CUPO', v_actuales, v_capacidad; RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'OK'::TEXT, v_actuales, v_capacidad;
END;
$function$;

-- Sembrar horarios generosos donde falten (locales con reservas activas).
UPDATE comanda_local_settings
   SET reservas_horarios = '[
     {"dia":1,"abre":"11:00","cierra":"23:59"},
     {"dia":2,"abre":"11:00","cierra":"23:59"},
     {"dia":3,"abre":"11:00","cierra":"23:59"},
     {"dia":4,"abre":"11:00","cierra":"23:59"},
     {"dia":5,"abre":"11:00","cierra":"23:59"},
     {"dia":6,"abre":"11:00","cierra":"23:59"},
     {"dia":0,"abre":"11:00","cierra":"23:59"}
   ]'::jsonb
 WHERE reservas_activas = TRUE
   AND (reservas_horarios IS NULL OR reservas_horarios = '[]'::jsonb);
