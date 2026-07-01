-- ============================================================
-- Reservas: disponibilidad por HORARIO (para los chips del widget nuevo).
-- Devuelve, para un día, cada franja de 30 min dentro del horario de apertura
-- con: disponible (bool) y restantes (mesas individuales libres que entran,
-- aprox → para el badge "quedan X"). Salta las franjas ya pasadas.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_slots_disponibilidad_publico(
  p_local_slug text, p_fecha date, p_personas integer, p_zona text DEFAULT NULL
)
RETURNS TABLE(hora text, disponible boolean, restantes integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER; v_horarios JSONB; v_dow INTEGER; v_dia JSONB;
  v_abre TIME; v_cierra TIME; v_slot_min INTEGER := 30; v_ts TIMESTAMPTZ;
  v_t TIME; v_disp BOOLEAN; v_mot TEXT; v_dur INTEGER; v_rest INTEGER; v_iter INTEGER := 0;
BEGIN
  SELECT cls.local_id, COALESCE(cls.reservas_horarios, '[]'::jsonb)
    INTO v_local_id, v_horarios
    FROM comanda_local_settings cls
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RETURN; END IF;

  v_dow := EXTRACT(DOW FROM p_fecha)::int;
  IF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
    FOR v_dia IN SELECT * FROM jsonb_array_elements(v_horarios) LOOP
      IF (v_dia->>'dia')::int = v_dow THEN
        v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
      END IF;
    END LOOP;
    IF v_abre IS NULL THEN RETURN; END IF;  -- cerrado ese día
  ELSE
    v_abre := '11:00'; v_cierra := '23:30';
  END IF;
  IF v_cierra <= v_abre THEN v_cierra := '23:30'; END IF;  -- guard anti loop
  v_dur := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  v_t := v_abre;
  WHILE v_t <= v_cierra AND v_iter < 48 LOOP
    v_iter := v_iter + 1;
    v_ts := (p_fecha::text || ' ' || to_char(v_t,'HH24:MI'))::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires';
    IF v_ts > NOW() THEN
      SELECT d.disponible, d.motivo INTO v_disp, v_mot
        FROM fn_check_disponibilidad_reserva(p_local_slug, v_ts, p_personas, p_zona) d;
      IF v_disp THEN
        SELECT COUNT(*) INTO v_rest FROM mesas m
          WHERE m.local_id = v_local_id AND m.deleted_at IS NULL AND m.reservable
            AND COALESCE(m.capacidad,0) >= p_personas AND (p_zona IS NULL OR m.zona = p_zona)
            AND NOT fn_mesa_ocupada_en(m.id, v_ts, v_dur, NULL);
      ELSE v_rest := 0; END IF;
      hora := to_char(v_t,'HH24:MI'); disponible := COALESCE(v_disp,FALSE); restantes := COALESCE(v_rest,0);
      RETURN NEXT;
    END IF;
    v_t := v_t + make_interval(mins => v_slot_min);
  END LOOP;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_slots_disponibilidad_publico(text, date, integer, text) TO anon, authenticated, service_role;
