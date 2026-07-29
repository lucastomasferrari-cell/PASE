-- ═══════════════════════════════════════════════════════════════════════════
-- Reservas — TURNOS EXPLÍCITOS con cupo por turno (opt-in, no rompe Maneki)
-- Sesión 2026-07-28
--
-- Hoy los horarios reservables se generan cada `reservas_slot_min` minutos
-- dentro del horario de apertura (Maneki: 120 min sobre 20:00–00:00 → 20:00 y
-- 22:00). Esto agrega un MODO alternativo: definir las horas exactas (ej. 20:00
-- y 22:30) con un cupo de personas por turno.
--
-- Aditivo y opt-in:
--   - reservas_turnos: lista JSONB de horas "HH:MM". Vacío/NULL = modo intervalo
--     de siempre (Maneki cae acá → NO cambia nada).
--   - reservas_cupo_por_turno: personas máximas por turno (cuando hay turnos).
--
-- La función de slots: si el local tiene turnos → muestra SOLO esas horas (que
-- caigan en el horario abierto del día), con "restantes" = cupo − personas ya
-- reservadas en ese turno. Si no tiene turnos → intervalo de siempre.
-- Un trigger BEFORE INSERT en reservas refuerza el cupo (no sobre-reservar).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_turnos JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reservas_cupo_por_turno INTEGER
    CHECK (reservas_cupo_por_turno IS NULL OR reservas_cupo_por_turno > 0);

COMMENT ON COLUMN comanda_local_settings.reservas_turnos IS
  'Turnos explícitos de reserva ["20:00","22:30"]. Vacío = modo intervalo (reservas_slot_min).';
COMMENT ON COLUMN comanda_local_settings.reservas_cupo_por_turno IS
  'Personas máximas por turno (solo aplica en modo turnos explícitos).';

-- ─── Slots públicos: rama de turnos explícitos + intervalo (fallback) ───────
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

-- ─── Refuerzo del cupo al crear la reserva (no sobre-reservar un turno) ─────
CREATE OR REPLACE FUNCTION public.fn_reservas_cupo_turno()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE v_turnos JSONB; v_cupo INTEGER; v_hhmm TEXT; v_tomados INTEGER;
BEGIN
  SELECT cls.reservas_turnos, cls.reservas_cupo_por_turno INTO v_turnos, v_cupo
    FROM comanda_local_settings cls WHERE cls.local_id = NEW.local_id LIMIT 1;
  -- Sin turnos o sin cupo → no aplica (Maneki y todos los del modo intervalo).
  IF v_cupo IS NULL OR v_turnos IS NULL OR jsonb_typeof(v_turnos) <> 'array'
     OR jsonb_array_length(v_turnos) = 0 THEN
    RETURN NEW;
  END IF;
  v_hhmm := to_char(NEW.fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI');
  -- Solo refuerza si la reserva cae en una hora de turno (no bloquea altas
  -- manuales del staff en horarios fuera de turno).
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_turnos) t WHERE t = v_hhmm) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(r.personas), 0) INTO v_tomados FROM reservas r
    WHERE r.local_id = NEW.local_id AND r.fecha_hora = NEW.fecha_hora
      AND r.deleted_at IS NULL AND r.estado NOT IN ('cancelada', 'no_show');
  IF v_tomados + COALESCE(NEW.personas, 0) > v_cupo THEN
    RAISE EXCEPTION 'CUPO_TURNO_COMPLETO';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reservas_cupo_turno ON reservas;
CREATE TRIGGER trg_reservas_cupo_turno
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION fn_reservas_cupo_turno();

NOTIFY pgrst, 'reload schema';
