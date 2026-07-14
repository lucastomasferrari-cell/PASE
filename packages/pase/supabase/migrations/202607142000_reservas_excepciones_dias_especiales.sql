-- ═══════════════════════════════════════════════════════════════════════════
-- MESA reservas: días especiales / excepciones por fecha.
--
-- Hasta ahora el horario de reservas era SOLO semanal (comanda_local_settings
-- .reservas_horarios, por día de semana). No había forma de abrir un día que
-- normalmente cierra (un feriado, un evento) ni de cerrar uno que abre, sin
-- cambiar el horario de ese día de la semana (y acordarse de revertirlo).
--
-- Esta migración agrega una tabla de excepciones POR FECHA que GANA sobre el
-- horario semanal, consultada en el juez único (fn_check_disponibilidad_reserva)
-- y en la grilla de turnos (fn_slots_disponibilidad_publico). Como el alta
-- pública (fn_crear_reserva_publica) re-llama al juez, queda cubierta sola.
--
-- El alta ADMIN (fn_crear_reserva) NO se toca: el staff puede seguir cargando
-- reservas manualmente cualquier día (override interno). Las excepciones sólo
-- afectan la disponibilidad PÚBLICA (link de reservas).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservas_excepciones (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT auth_tenant_id(),
  local_id    INTEGER NOT NULL,
  fecha       DATE NOT NULL,
  cerrado     BOOLEAN NOT NULL DEFAULT TRUE,   -- TRUE = cerrado ese día; FALSE = abierto excepcional
  abre        TIME,                            -- requerido si cerrado = FALSE
  cierra      TIME,                            -- requerido si cerrado = FALSE
  nota        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_reservas_excepcion_local_fecha UNIQUE (local_id, fecha),
  CONSTRAINT chk_reservas_excepcion_abierto CHECK (cerrado OR (abre IS NOT NULL AND cierra IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_reservas_excepciones_local_fecha
  ON reservas_excepciones (local_id, fecha);

DROP TRIGGER IF EXISTS trg_reservas_excepciones_updated_at ON reservas_excepciones;
CREATE TRIGGER trg_reservas_excepciones_updated_at
  BEFORE UPDATE ON reservas_excepciones
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 2. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE reservas_excepciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservas_excepciones_rw ON reservas_excepciones;
CREATE POLICY reservas_excepciones_rw ON reservas_excepciones
  FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

GRANT SELECT, INSERT, UPDATE, DELETE ON reservas_excepciones TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE reservas_excepciones_id_seq TO authenticated;

-- ─── 3. Juez único: excepción por fecha ANTES del horario semanal ───────────
DROP FUNCTION IF EXISTS public.fn_check_disponibilidad_reserva(text, timestamptz, integer);
CREATE OR REPLACE FUNCTION public.fn_check_disponibilidad_reserva(
  p_local_slug text, p_fecha_hora timestamp with time zone, p_personas integer, p_zona text DEFAULT NULL
)
RETURNS TABLE(disponible boolean, motivo text, personas_actuales integer, capacidad_max integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_local_id INTEGER; v_activas BOOLEAN; v_capacidad INTEGER; v_duracion INTEGER;
  v_anticip_min INTEGER; v_anticip_max INTEGER; v_actuales INTEGER;
  v_now TIMESTAMPTZ := NOW(); v_dur_pedida INTEGER; v_horarios JSONB;
  v_local_ts TIMESTAMP; v_dow INTEGER; v_hora TIME; v_abre TIME; v_cierra TIME;
  v_dia JSONB; v_encontrado BOOLEAN := FALSE; v_en_rango BOOLEAN := FALSE;
  v_motor TEXT; v_combinar BOOLEAN; v_pacing INTEGER; v_franja INTEGER;
  v_usar_mesas BOOLEAN; v_hay_mesas BOOLEAN; v_mesas bigint[];
  v_franja_ini TIMESTAMPTZ; v_cnt_franja INTEGER; v_cap_mesas INTEGER;
  v_exc_cerrado BOOLEAN; v_exc_abre TIME; v_exc_cierra TIME;
BEGIN
  SELECT cls.local_id, cls.reservas_activas, COALESCE(cls.reservas_capacidad_max, 50),
         cls.reservas_duracion_estimada_min, cls.reservas_anticipacion_min_hs,
         cls.reservas_anticipacion_max_dias, COALESCE(cls.reservas_horarios, '[]'::jsonb),
         COALESCE(cls.reservas_motor,'auto'), COALESCE(cls.reservas_permite_combinar,TRUE),
         cls.reservas_pacing_max_por_franja, COALESCE(cls.reservas_franja_min,15)
    INTO v_local_id, v_activas, v_capacidad, v_duracion, v_anticip_min, v_anticip_max,
         v_horarios, v_motor, v_combinar, v_pacing, v_franja
    FROM comanda_local_settings cls
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN RETURN QUERY SELECT FALSE,'LOCAL_NO_ENCONTRADO',0,0; RETURN; END IF;
  IF NOT v_activas THEN RETURN QUERY SELECT FALSE,'RESERVAS_DESACTIVADAS',0,v_capacidad; RETURN; END IF;
  IF p_personas < 1 OR p_personas > 50 THEN RETURN QUERY SELECT FALSE,'PERSONAS_INVALIDAS',0,v_capacidad; RETURN; END IF;
  IF p_fecha_hora < v_now + (v_anticip_min || ' hours')::INTERVAL THEN
    RETURN QUERY SELECT FALSE,'ANTICIPACION_INSUFICIENTE',0,v_capacidad; RETURN; END IF;
  IF p_fecha_hora > v_now + (v_anticip_max || ' days')::INTERVAL THEN
    RETURN QUERY SELECT FALSE,'FECHA_DEMASIADO_LEJANA',0,v_capacidad; RETURN; END IF;

  v_local_ts := p_fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires';
  v_hora := v_local_ts::time;

  -- Excepción por fecha (día especial): GANA sobre el horario semanal.
  SELECT e.cerrado, e.abre, e.cierra INTO v_exc_cerrado, v_exc_abre, v_exc_cierra
    FROM reservas_excepciones e
    WHERE e.local_id = v_local_id AND e.fecha = v_local_ts::date
    LIMIT 1;

  IF FOUND THEN
    IF v_exc_cerrado THEN RETURN QUERY SELECT FALSE,'CERRADO_ESE_DIA',0,v_capacidad; RETURN; END IF;
    -- Abierto excepcional: usar el horario de la excepción.
    v_abre := v_exc_abre; v_cierra := v_exc_cierra;
    IF v_cierra > v_abre THEN v_en_rango := v_hora >= v_abre AND v_hora <= v_cierra;
    ELSE v_en_rango := v_hora >= v_abre OR v_hora <= v_cierra; END IF;
    IF NOT v_en_rango THEN RETURN QUERY SELECT FALSE,'FUERA_DE_HORARIO',0,v_capacidad; RETURN; END IF;
  ELSIF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
    v_dow := EXTRACT(DOW FROM v_local_ts)::int;
    FOR v_dia IN SELECT * FROM jsonb_array_elements(v_horarios) LOOP
      IF (v_dia->>'dia')::int = v_dow THEN
        v_encontrado := TRUE; v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
        IF v_cierra > v_abre THEN v_en_rango := v_hora >= v_abre AND v_hora <= v_cierra;
        ELSE v_en_rango := v_hora >= v_abre OR v_hora <= v_cierra; END IF;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_encontrado THEN RETURN QUERY SELECT FALSE,'CERRADO_ESE_DIA',0,v_capacidad; RETURN; END IF;
    IF NOT v_en_rango THEN RETURN QUERY SELECT FALSE,'FUERA_DE_HORARIO',0,v_capacidad; RETURN; END IF;
  END IF;

  v_dur_pedida := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  IF v_pacing IS NOT NULL AND v_pacing > 0 THEN
    v_franja_ini := date_trunc('hour', p_fecha_hora)
      + (floor(EXTRACT(MINUTE FROM p_fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires') / v_franja) * v_franja) * INTERVAL '1 minute';
    SELECT COUNT(*) INTO v_cnt_franja FROM reservas r
    WHERE r.local_id = v_local_id AND r.deleted_at IS NULL
      AND r.estado IN ('pendiente','confirmada','sentada')
      AND r.fecha_hora >= v_franja_ini AND r.fecha_hora < v_franja_ini + make_interval(mins => v_franja);
    IF v_cnt_franja >= v_pacing THEN RETURN QUERY SELECT FALSE,'PACING_COMPLETO',v_cnt_franja,v_capacidad; RETURN; END IF;
  END IF;

  SELECT EXISTS(SELECT 1 FROM mesas m WHERE m.local_id=v_local_id AND m.deleted_at IS NULL AND m.reservable
                  AND COALESCE(m.capacidad,0)>0 AND (p_zona IS NULL OR m.zona=p_zona))
    INTO v_hay_mesas;
  v_usar_mesas := (v_motor = 'mesas') OR (v_motor = 'auto' AND v_hay_mesas) OR (p_zona IS NOT NULL);

  IF v_usar_mesas THEN
    v_mesas := fn_buscar_mesas_reserva(v_local_id, p_fecha_hora, v_dur_pedida, p_personas, v_combinar, p_zona);
    SELECT COALESCE(SUM(m.capacidad),0) INTO v_cap_mesas FROM mesas m
      WHERE m.local_id=v_local_id AND m.deleted_at IS NULL AND m.reservable AND (p_zona IS NULL OR m.zona=p_zona);
    IF v_mesas IS NULL OR array_length(v_mesas,1) IS NULL THEN
      RETURN QUERY SELECT FALSE,'SIN_MESA',0,v_cap_mesas; RETURN;
    END IF;
    RETURN QUERY SELECT TRUE,'OK'::TEXT,0,v_cap_mesas; RETURN;
  END IF;

  SELECT COALESCE(SUM(r.personas),0) INTO v_actuales FROM reservas r
  WHERE r.local_id = v_local_id AND r.estado IN ('pendiente','confirmada','sentada') AND r.deleted_at IS NULL
    AND r.fecha_hora < p_fecha_hora + make_interval(mins => v_dur_pedida)
    AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, v_duracion, 90)) > p_fecha_hora;
  IF v_actuales + p_personas > v_capacidad THEN RETURN QUERY SELECT FALSE,'SIN_CUPO',v_actuales,v_capacidad; RETURN; END IF;
  RETURN QUERY SELECT TRUE,'OK'::TEXT,v_actuales,v_capacidad;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_check_disponibilidad_reserva(text, timestamptz, integer, text) TO anon, authenticated, service_role;

-- ─── 4. Grilla de turnos: excepción por fecha ANTES del horario semanal ─────
CREATE OR REPLACE FUNCTION public.fn_slots_disponibilidad_publico(
  p_local_slug text, p_fecha date, p_personas integer, p_zona text DEFAULT NULL
)
RETURNS TABLE(hora text, disponible boolean, restantes integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_local_id INTEGER; v_horarios JSONB; v_dow INTEGER; v_dia JSONB;
  v_abre TIME; v_cierra TIME; v_slot_min INTEGER; v_ts TIMESTAMPTZ;
  v_disp BOOLEAN; v_mot TEXT; v_dur INTEGER; v_rest INTEGER;
  v_cur INTEGER; v_fin INTEGER; v_hhmm TEXT; v_anticip INTEGER; v_min_ts TIMESTAMPTZ;
  v_exc_cerrado BOOLEAN; v_exc_abre TIME; v_exc_cierra TIME;
BEGIN
  SELECT cls.local_id, COALESCE(cls.reservas_horarios, '[]'::jsonb),
         COALESCE(cls.reservas_anticipacion_min_hs, 0), COALESCE(cls.reservas_slot_min, 30)
    INTO v_local_id, v_horarios, v_anticip, v_slot_min
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
    v_abre := v_exc_abre; v_cierra := v_exc_cierra;
  ELSE
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
  END IF;

  v_cur := (EXTRACT(HOUR FROM v_abre) * 60 + EXTRACT(MINUTE FROM v_abre))::int;
  v_fin := (EXTRACT(HOUR FROM v_cierra) * 60 + EXTRACT(MINUTE FROM v_cierra))::int;
  -- Cierre a la medianoche (00:00) o pasada → tratar como fin del día.
  IF v_fin <= v_cur THEN v_fin := 24 * 60; END IF;
  v_dur := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

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
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_slots_disponibilidad_publico(text, date, integer, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
