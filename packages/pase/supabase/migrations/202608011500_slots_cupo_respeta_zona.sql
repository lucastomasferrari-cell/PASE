-- Fix: turnos con cupo ignoraban la capacidad de mesas por zona (01-ago-2026)
-- ---------------------------------------------------------------------------
-- Bug (Lucas): en la página pública, Belgrano/Devoto (turnos con cupo por turno)
-- dejaban reservar 20 personas en "Terraza" (3 mesas, 10 asientos) o 18 en
-- "Barra" (4 mesas, 8 asientos). Causa: en el modo "turnos con cupo",
-- fn_slots_disponibilidad_publico solo chequeaba `cupo − reservados ≥ personas`
-- y NO validaba que el grupo entrara físicamente en las mesas de la zona.
-- (fn_check_disponibilidad_reserva sí lo hacía, pero la rama de cupo no lo
-- llamaba.)
--
-- Fix quirúrgico: el cupo por turno sigue siendo el tope GLOBAL del salón
-- (para "cualquier lugar" manda el cupo, como definió Lucas el 28-jul), pero si
-- el cliente elige una ZONA puntual, además tiene que entrar en las mesas de
-- esa zona. Solo se agrega ese AND en la rama de cupo; el resto queda idéntico.

CREATE OR REPLACE FUNCTION public.fn_slots_disponibilidad_publico(p_local_slug text, p_fecha date, p_personas integer, p_zona text DEFAULT NULL::text)
 RETURNS TABLE(hora text, disponible boolean, restantes integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_local_id INTEGER; v_horarios JSONB; v_dow INTEGER; v_dia JSONB;
  v_abre TIME; v_cierra TIME; v_slot_min INTEGER; v_ts TIMESTAMPTZ;
  v_disp BOOLEAN; v_mot TEXT; v_dur INTEGER; v_rest INTEGER;
  v_cur INTEGER; v_fin INTEGER; v_hhmm TEXT; v_anticip INTEGER; v_min_ts TIMESTAMPTZ;
  v_exc_cerrado BOOLEAN; v_exc_abre TIME; v_exc_cierra TIME; v_franjas JSONB;
  -- turnos explícitos
  v_turnos JSONB; v_cupo INTEGER; v_turno_txt TEXT; v_amin INTEGER; v_en_franja BOOLEAN; v_tomados INTEGER;
BEGIN
  SELECT cls.local_id, COALESCE(cls.reservas_horarios, '[]'::jsonb),
         COALESCE(cls.reservas_anticipacion_min_hs, 0), COALESCE(cls.reservas_slot_min, 30),
         COALESCE(cls.reservas_turnos, '[]'::jsonb), cls.reservas_cupo_por_turno
    INTO v_local_id, v_horarios, v_anticip, v_slot_min, v_turnos, v_cupo
    FROM comanda_local_settings cls
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RETURN; END IF;
  IF v_slot_min < 5 THEN v_slot_min := 30; END IF;

  v_min_ts := NOW() + (v_anticip || ' hours')::interval;

  -- Excepción por fecha (día especial): GANA sobre el horario semanal.
  SELECT e.cerrado, e.abre, e.cierra INTO v_exc_cerrado, v_exc_abre, v_exc_cierra
    FROM reservas_excepciones e
    WHERE e.local_id = v_local_id AND e.fecha = p_fecha
    LIMIT 1;

  IF FOUND THEN
    IF v_exc_cerrado THEN RETURN; END IF;   -- cerrado ese día: sin turnos
    IF v_exc_abre IS NULL OR v_exc_cierra IS NULL THEN RETURN; END IF;
    v_franjas := jsonb_build_array(jsonb_build_object(
      'abre', to_char(v_exc_abre,'HH24:MI'), 'cierra', to_char(v_exc_cierra,'HH24:MI')));
  ELSE
    v_dow := EXTRACT(DOW FROM p_fecha)::int;
    IF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
      SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'abre')), '[]'::jsonb) INTO v_franjas
        FROM jsonb_array_elements(v_horarios) e WHERE (e->>'dia')::int = v_dow;
      IF jsonb_array_length(v_franjas) = 0 THEN RETURN; END IF;  -- cerrado ese día
    ELSE
      v_franjas := jsonb_build_array(jsonb_build_object('abre','11:00','cierra','23:30'));
    END IF;
  END IF;

  v_dur := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  -- ── MODO TURNOS EXPLÍCITOS ────────────────────────────────────────────────
  -- Si el local definió turnos, mostramos SOLO esas horas (las que caen en el
  -- horario abierto del día). Cupo por turno = personas. NO se corre el intervalo.
  IF jsonb_typeof(v_turnos) = 'array' AND jsonb_array_length(v_turnos) > 0 THEN
    FOR v_turno_txt IN SELECT jsonb_array_elements_text(v_turnos) LOOP
      CONTINUE WHEN v_turno_txt !~ '^\d{1,2}:\d{2}$';
      v_cur := (split_part(v_turno_txt, ':', 1))::int * 60 + (split_part(v_turno_txt, ':', 2))::int;
      -- ¿el turno cae dentro de alguna franja abierta del día?
      v_en_franja := FALSE;
      FOR v_dia IN SELECT * FROM jsonb_array_elements(v_franjas) LOOP
        v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
        v_amin := (EXTRACT(HOUR FROM v_abre) * 60 + EXTRACT(MINUTE FROM v_abre))::int;
        v_fin  := (EXTRACT(HOUR FROM v_cierra) * 60 + EXTRACT(MINUTE FROM v_cierra))::int;
        IF v_fin <= v_amin THEN v_fin := 24 * 60; END IF;  -- cierre pasada medianoche
        IF v_cur >= v_amin AND v_cur < v_fin THEN v_en_franja := TRUE; END IF;
      END LOOP;
      CONTINUE WHEN NOT v_en_franja;

      v_hhmm := lpad(((v_cur / 60) % 24)::text, 2, '0') || ':' || lpad((v_cur % 60)::text, 2, '0');
      v_ts := (p_fecha::text || ' ' || v_hhmm)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires';
      CONTINUE WHEN v_ts < v_min_ts;

      IF v_cupo IS NOT NULL THEN
        -- Cupo manda: restantes = cupo − personas ya reservadas en ese turno.
        SELECT COALESCE(SUM(r.personas), 0) INTO v_tomados FROM reservas r
          WHERE r.local_id = v_local_id AND r.fecha_hora = v_ts
            AND r.deleted_at IS NULL AND r.estado NOT IN ('cancelada', 'no_show');
        v_rest := v_cupo - v_tomados;
        v_disp := v_rest >= p_personas;
        -- Fix 01-ago: el cupo por turno es el tope GLOBAL del salón. Si el
        -- cliente eligió una ZONA puntual (Terraza/Barra/…), además tiene que
        -- entrar físicamente en las mesas de esa zona — el cupo global no
        -- habilita más gente de la que las mesas de la zona pueden sentar.
        IF v_disp AND p_zona IS NOT NULL THEN
          SELECT COALESCE(d.disponible, FALSE) INTO v_disp
            FROM fn_check_disponibilidad_reserva(p_local_slug, v_ts, p_personas, p_zona) d;
        END IF;
        IF v_rest < 0 THEN v_rest := 0; END IF;
      ELSE
        -- Sin cupo: cae en la disponibilidad por mesa de siempre.
        SELECT d.disponible INTO v_disp FROM fn_check_disponibilidad_reserva(p_local_slug, v_ts, p_personas, p_zona) d;
        IF v_disp THEN
          SELECT COUNT(*) INTO v_rest FROM mesas m
            WHERE m.local_id = v_local_id AND m.deleted_at IS NULL AND m.reservable
              AND COALESCE(m.capacidad,0) >= p_personas AND (p_zona IS NULL OR m.zona = p_zona)
              AND NOT fn_mesa_ocupada_en(m.id, v_ts, v_dur, NULL);
        ELSE v_rest := 0; END IF;
      END IF;

      hora := v_hhmm; disponible := COALESCE(v_disp, FALSE); restantes := COALESCE(v_rest, 0);
      RETURN NEXT;
    END LOOP;
    RETURN;  -- modo turnos: no correr el intervalo
  END IF;

  -- ── MODO INTERVALO (comportamiento de siempre — Maneki) ───────────────────
  FOR v_dia IN SELECT * FROM jsonb_array_elements(v_franjas) LOOP
    v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
    IF v_abre IS NULL OR v_cierra IS NULL THEN CONTINUE; END IF;
    v_cur := (EXTRACT(HOUR FROM v_abre) * 60 + EXTRACT(MINUTE FROM v_abre))::int;
    v_fin := (EXTRACT(HOUR FROM v_cierra) * 60 + EXTRACT(MINUTE FROM v_cierra))::int;
    IF v_fin <= v_cur THEN v_fin := 24 * 60; END IF;
    WHILE v_cur < v_fin LOOP
      v_hhmm := lpad(((v_cur / 60) % 24)::text, 2, '0') || ':' || lpad((v_cur % 60)::text, 2, '0');
      v_ts := (p_fecha::text || ' ' || v_hhmm)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires';
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
  END LOOP;
END;
$function$;
