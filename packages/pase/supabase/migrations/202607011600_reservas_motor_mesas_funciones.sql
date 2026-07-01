-- ============================================================
-- Motor de reservas por MESA REAL — parte 2: funciones.
--   fn_mesa_ocupada_en        → ¿una mesa está tomada en una ventana?
--   fn_buscar_mesas_reserva   → mejor mesa (o combo de 2) libre para el grupo
--   fn_check_disponibilidad_reserva (reescrita) → horario → pacing → mesa/cupo
--   fn_crear_reserva_publica  (reescrita) → auto-asigna mesa bajo advisory lock
-- ============================================================

-- ¿La mesa está ocupada por otra reserva activa que se solapa con la ventana?
CREATE OR REPLACE FUNCTION public.fn_mesa_ocupada_en(
  p_mesa_id bigint, p_inicio timestamptz, p_dur_min integer, p_excluir bigint DEFAULT NULL
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS(
    SELECT 1 FROM reservas r
    WHERE r.estado IN ('pendiente','confirmada','sentada') AND r.deleted_at IS NULL
      AND (r.mesa_id = p_mesa_id OR p_mesa_id = ANY(COALESCE(r.mesas_ids, ARRAY[]::bigint[])))
      AND (p_excluir IS NULL OR r.id <> p_excluir)
      AND r.fecha_hora < p_inicio + make_interval(mins => p_dur_min)
      AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, 90)) > p_inicio
  );
$$;

-- Devuelve las mesas asignables (1 mesa, o combo de 2) libres para el grupo.
-- Vacío = no hay mesa. Prioriza: mejor mesa individual (menor capacidad que
-- entre); si no, combo de 2 (misma zona preferida, menor exceso).
CREATE OR REPLACE FUNCTION public.fn_buscar_mesas_reserva(
  p_local_id integer, p_inicio timestamptz, p_dur_min integer,
  p_personas integer, p_permite_combinar boolean
)
RETURNS bigint[] LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_mesa bigint; v_par bigint[];
BEGIN
  -- 1) Mejor mesa individual que entre.
  SELECT m.id INTO v_mesa
  FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC
  LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  -- 2) Combo de 2 mesas libres (si está permitido).
  IF p_permite_combinar THEN
    SELECT ARRAY[a.id, b.id] INTO v_par
    FROM mesas a
    JOIN mesas b ON b.local_id = a.local_id AND b.id > a.id
    WHERE a.local_id = p_local_id
      AND a.deleted_at IS NULL AND a.reservable
      AND b.deleted_at IS NULL AND b.reservable
      AND COALESCE(a.capacidad,0) + COALESCE(b.capacidad,0) >= p_personas
      AND NOT fn_mesa_ocupada_en(a.id, p_inicio, p_dur_min, NULL)
      AND NOT fn_mesa_ocupada_en(b.id, p_inicio, p_dur_min, NULL)
    ORDER BY (a.zona IS DISTINCT FROM b.zona),
             (COALESCE(a.capacidad,0) + COALESCE(b.capacidad,0)) ASC, a.id
    LIMIT 1;
    IF v_par IS NOT NULL THEN RETURN v_par; END IF;
  END IF;

  RETURN ARRAY[]::bigint[];
END;
$$;

-- ── Disponibilidad: horario → pacing → mesa real (o cupo global de fallback) ──
CREATE OR REPLACE FUNCTION public.fn_check_disponibilidad_reserva(
  p_local_slug text, p_fecha_hora timestamp with time zone, p_personas integer
)
RETURNS TABLE(disponible boolean, motivo text, personas_actuales integer, capacidad_max integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
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

  -- Horario de apertura
  IF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
    v_local_ts := p_fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_dow := EXTRACT(DOW FROM v_local_ts)::int; v_hora := v_local_ts::time;
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

  -- Pacing: máx reservas que arrancan en la misma franja.
  IF v_pacing IS NOT NULL AND v_pacing > 0 THEN
    v_franja_ini := date_trunc('hour', p_fecha_hora)
      + (floor(EXTRACT(MINUTE FROM p_fecha_hora AT TIME ZONE 'America/Argentina/Buenos_Aires') / v_franja) * v_franja) * INTERVAL '1 minute';
    SELECT COUNT(*) INTO v_cnt_franja FROM reservas r
    WHERE r.local_id = v_local_id AND r.deleted_at IS NULL
      AND r.estado IN ('pendiente','confirmada','sentada')
      AND r.fecha_hora >= v_franja_ini AND r.fecha_hora < v_franja_ini + make_interval(mins => v_franja);
    IF v_cnt_franja >= v_pacing THEN RETURN QUERY SELECT FALSE,'PACING_COMPLETO',v_cnt_franja,v_capacidad; RETURN; END IF;
  END IF;

  -- ¿Motor por mesa o cupo global?
  SELECT EXISTS(SELECT 1 FROM mesas m WHERE m.local_id=v_local_id AND m.deleted_at IS NULL AND m.reservable AND COALESCE(m.capacidad,0)>0)
    INTO v_hay_mesas;
  v_usar_mesas := (v_motor = 'mesas') OR (v_motor = 'auto' AND v_hay_mesas);

  IF v_usar_mesas THEN
    v_mesas := fn_buscar_mesas_reserva(v_local_id, p_fecha_hora, v_dur_pedida, p_personas, v_combinar);
    SELECT COALESCE(SUM(m.capacidad),0) INTO v_cap_mesas FROM mesas m
      WHERE m.local_id=v_local_id AND m.deleted_at IS NULL AND m.reservable;
    IF v_mesas IS NULL OR array_length(v_mesas,1) IS NULL THEN
      RETURN QUERY SELECT FALSE,'SIN_MESA',0,v_cap_mesas; RETURN;
    END IF;
    RETURN QUERY SELECT TRUE,'OK'::TEXT,0,v_cap_mesas; RETURN;
  END IF;

  -- Fallback: cupo global por cubiertos (locales sin mesas cargadas).
  SELECT COALESCE(SUM(r.personas),0) INTO v_actuales FROM reservas r
  WHERE r.local_id = v_local_id AND r.estado IN ('pendiente','confirmada','sentada') AND r.deleted_at IS NULL
    AND r.fecha_hora < p_fecha_hora + make_interval(mins => v_dur_pedida)
    AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, v_duracion, 90)) > p_fecha_hora;
  IF v_actuales + p_personas > v_capacidad THEN RETURN QUERY SELECT FALSE,'SIN_CUPO',v_actuales,v_capacidad; RETURN; END IF;
  RETURN QUERY SELECT TRUE,'OK'::TEXT,v_actuales,v_capacidad;
END;
$function$;

-- ── Alta pública: valida + AUTO-ASIGNA mesa bajo advisory lock (anti carrera) ──
CREATE OR REPLACE FUNCTION public.fn_crear_reserva_publica(
  p_local_slug text, p_cliente_nombre text, p_cliente_telefono text,
  p_cliente_email text, p_fecha_hora timestamp with time zone,
  p_personas integer, p_notas text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text
)
RETURNS TABLE(id bigint, estado text)
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_id UUID; v_local_id INTEGER; v_disponible BOOLEAN; v_motivo TEXT;
  v_existing BIGINT; v_new_id BIGINT; v_requiere_confirm BOOLEAN; v_estado_inicial TEXT;
  v_tel_oblig BOOLEAN; v_cliente_id BIGINT; v_duracion INTEGER; v_tel_norm TEXT;
  v_cnt_tel INTEGER; v_cnt_burst INTEGER; v_motor TEXT; v_combinar BOOLEAN;
  v_hay_mesas BOOLEAN; v_usar_mesas BOOLEAN; v_mesas bigint[]; v_mesa_prim BIGINT;
BEGIN
  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT r.id INTO v_existing FROM reservas r
    INNER JOIN comanda_local_settings cls ON cls.local_id = r.local_id
    WHERE cls.slug = p_local_slug AND r.idempotency_key = p_idempotency_key AND r.deleted_at IS NULL;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT v_existing, (SELECT r2.estado FROM reservas r2 WHERE r2.id = v_existing); RETURN;
    END IF;
  END IF;

  SELECT cls.local_id, l.tenant_id, cls.reservas_requiere_confirmacion, cls.reservas_telefono_obligatorio,
         COALESCE(cls.reservas_motor,'auto'), COALESCE(cls.reservas_permite_combinar,TRUE)
    INTO v_local_id, v_tenant_id, v_requiere_confirm, v_tel_oblig, v_motor, v_combinar
    FROM comanda_local_settings cls INNER JOIN locales l ON l.id = cls.local_id
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  IF v_tel_oblig AND (p_cliente_telefono IS NULL OR length(trim(p_cliente_telefono)) < 6) THEN
    RAISE EXCEPTION 'TELEFONO_REQUERIDO'; END IF;
  IF p_cliente_nombre IS NULL OR length(trim(p_cliente_nombre)) < 2 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;

  -- Anti-abuso (por teléfono + ráfaga por local)
  v_tel_norm := regexp_replace(COALESCE(p_cliente_telefono,''), '[^0-9]', '', 'g');
  IF length(v_tel_norm) >= 6 THEN
    SELECT COUNT(*) INTO v_cnt_tel FROM reservas r
    WHERE r.local_id = v_local_id
      AND regexp_replace(COALESCE(r.cliente_telefono,''),'[^0-9]','','g') = v_tel_norm
      AND r.estado IN ('pendiente','confirmada') AND r.fecha_hora > NOW() AND r.deleted_at IS NULL;
    IF v_cnt_tel >= 4 THEN RAISE EXCEPTION 'DEMASIADAS_RESERVAS'; END IF;
  END IF;
  SELECT COUNT(*) INTO v_cnt_burst FROM reservas r
  WHERE r.local_id = v_local_id AND r.created_at > NOW() - INTERVAL '5 minutes';
  IF v_cnt_burst >= 12 THEN RAISE EXCEPTION 'DEMASIADO_RAPIDO'; END IF;

  -- Serializar la asignación de mesa para este local (evita doble-reserva de
  -- la misma mesa entre dos altas concurrentes).
  PERFORM pg_advisory_xact_lock(v_local_id::bigint);

  -- Re-validar disponibilidad DENTRO del lock (horario/pacing/mesa).
  SELECT d.disponible, d.motivo INTO v_disponible, v_motivo
  FROM fn_check_disponibilidad_reserva(p_local_slug, p_fecha_hora, p_personas) d;
  IF NOT v_disponible THEN RAISE EXCEPTION '%', v_motivo; END IF;

  v_duracion := fn_duracion_reserva_default(v_local_id, p_personas);

  -- Auto-asignar mesa(s) si corresponde el motor por mesa.
  SELECT EXISTS(SELECT 1 FROM mesas m WHERE m.local_id=v_local_id AND m.deleted_at IS NULL AND m.reservable AND COALESCE(m.capacidad,0)>0)
    INTO v_hay_mesas;
  v_usar_mesas := (v_motor = 'mesas') OR (v_motor = 'auto' AND v_hay_mesas);
  IF v_usar_mesas THEN
    v_mesas := fn_buscar_mesas_reserva(v_local_id, p_fecha_hora, v_duracion, p_personas, v_combinar);
    IF v_mesas IS NULL OR array_length(v_mesas,1) IS NULL THEN RAISE EXCEPTION 'SIN_MESA'; END IF;
    v_mesa_prim := v_mesas[1];
  END IF;

  v_estado_inicial := CASE WHEN v_requiere_confirm THEN 'pendiente' ELSE 'confirmada' END;

  INSERT INTO reservas (
    tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
    fecha_hora, personas, duracion_min, notas, estado, idempotency_key,
    confirmada_at, mesa_id, mesas_ids
  ) VALUES (
    v_tenant_id, v_local_id, trim(p_cliente_nombre),
    NULLIF(trim(p_cliente_telefono), ''), NULLIF(trim(p_cliente_email), ''),
    p_fecha_hora, p_personas, v_duracion, NULLIF(trim(p_notas), ''), v_estado_inicial, p_idempotency_key,
    CASE WHEN v_estado_inicial = 'confirmada' THEN NOW() ELSE NULL END,
    v_mesa_prim, v_mesas
  ) RETURNING reservas.id INTO v_new_id;

  IF p_cliente_telefono IS NOT NULL AND length(trim(p_cliente_telefono)) >= 6 THEN
    BEGIN
      v_cliente_id := fn_upsert_cliente_publico_comanda(
        p_local_slug, trim(p_cliente_telefono), trim(p_cliente_nombre),
        NULLIF(trim(p_cliente_email), ''), NULL, NULL);
      IF v_cliente_id IS NOT NULL THEN
        UPDATE reservas SET cliente_id = v_cliente_id, updated_at = NOW() WHERE reservas.id = v_new_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN QUERY SELECT v_new_id, v_estado_inicial;
END;
$function$;
