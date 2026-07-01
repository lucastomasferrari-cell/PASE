-- Fix: los slots dentro de la anticipación mínima (o pasados) se mostraban
-- como "LLENO" cuando en realidad son "demasiado pronto". Ahora la RPC de
-- slots directamente NO los emite (solo devuelve turnos realmente reservables),
-- así "LLENO" queda reservado para cuando de verdad no hay mesa.
CREATE OR REPLACE FUNCTION public.fn_slots_disponibilidad_publico(
  p_local_slug text, p_fecha date, p_personas integer, p_zona text DEFAULT NULL
)
RETURNS TABLE(hora text, disponible boolean, restantes integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER; v_horarios JSONB; v_dow INTEGER; v_dia JSONB;
  v_abre TIME; v_cierra TIME; v_slot_min INTEGER := 30; v_ts TIMESTAMPTZ;
  v_disp BOOLEAN; v_mot TEXT; v_dur INTEGER; v_rest INTEGER;
  v_cur INTEGER; v_fin INTEGER; v_hhmm TEXT; v_anticip INTEGER; v_min_ts TIMESTAMPTZ;
BEGIN
  SELECT cls.local_id, COALESCE(cls.reservas_horarios, '[]'::jsonb),
         COALESCE(cls.reservas_anticipacion_min_hs, 0)
    INTO v_local_id, v_horarios, v_anticip
    FROM comanda_local_settings cls
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RETURN; END IF;

  v_min_ts := NOW() + (v_anticip || ' hours')::interval;

  v_dow := EXTRACT(DOW FROM p_fecha)::int;
  IF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
    FOR v_dia IN SELECT * FROM jsonb_array_elements(v_horarios) LOOP
      IF (v_dia->>'dia')::int = v_dow THEN
        v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
      END IF;
    END LOOP;
    IF v_abre IS NULL THEN RETURN; END IF;
  ELSE
    v_abre := '11:00'; v_cierra := '23:30';
  END IF;

  v_cur := (EXTRACT(HOUR FROM v_abre) * 60 + EXTRACT(MINUTE FROM v_abre))::int;
  v_fin := (EXTRACT(HOUR FROM v_cierra) * 60 + EXTRACT(MINUTE FROM v_cierra))::int;
  IF v_fin <= v_cur THEN v_fin := 23 * 60 + 30; END IF;
  v_dur := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  WHILE v_cur <= v_fin LOOP
    v_hhmm := lpad((v_cur / 60)::text, 2, '0') || ':' || lpad((v_cur % 60)::text, 2, '0');
    v_ts := (p_fecha::text || ' ' || v_hhmm)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires';
    -- Solo turnos realmente reservables (respetando la anticipación mínima).
    IF v_ts >= v_min_ts THEN
      SELECT d.disponible, d.motivo INTO v_disp, v_mot
        FROM fn_check_disponibilidad_reserva(p_local_slug, v_ts, p_personas, p_zona) d;
      IF v_disp THEN
        SELECT COUNT(*) INTO v_rest FROM mesas m
          WHERE m.local_id = v_local_id AND m.deleted_at IS NULL AND m.reservable
            AND COALESCE(m.capacidad,0) >= p_personas AND (p_zona IS NULL OR m.zona = p_zona)
            AND NOT fn_mesa_ocupada_en(m.id, v_ts, v_dur, NULL);
      ELSE v_rest := 0; END IF;
      hora := v_hhmm; disponible := COALESCE(v_disp,FALSE); restantes := COALESCE(v_rest,0);
      RETURN NEXT;
    END IF;
    v_cur := v_cur + v_slot_min;
  END LOOP;
END;
$function$;
