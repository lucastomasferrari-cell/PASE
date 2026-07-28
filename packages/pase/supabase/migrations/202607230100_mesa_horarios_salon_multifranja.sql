-- MESA — Desacoplar los horarios del SALÓN (reservas) de los del DELIVERY
-- (tienda/marketplace) + permitir MÚLTIPLES FRANJAS por día (almuerzo + cena).
--
-- Antes: `horario_lun..sab` (texto, 1 rango/día) era la fuente ÚNICA, compartida
-- por tienda online Y (vía trigger que derivaba `reservas_horarios`) por MESA.
-- Problema real (Lucas, VC): el delivery abre domingo pero el salón no → con la
-- fuente compartida es imposible.
--
-- Ahora:
--   · `reservas_horarios` (jsonb [{dia,abre,cierra}]) = horarios del SALÓN,
--     editable DIRECTO desde la config de MESA, con varias franjas por día.
--   · `horario_lun..sab` (texto) = horarios del DELIVERY, siguen manejándose
--     desde la config de la tienda, INDEPENDIENTES.
--   · Se elimina el trigger que derivaba uno del otro (los desacopla).

-- 1. Seed: asegurar que reservas_horarios tenga el valor actual antes de soltar
--    el trigger (las filas ya vienen sincronizadas; esto solo cubre vacíos).
UPDATE public.comanda_local_settings c
   SET reservas_horarios = fn_derivar_reservas_horarios(c)
 WHERE deleted_at IS NULL
   AND (reservas_horarios IS NULL OR reservas_horarios = '[]'::jsonb);

-- 2. Soltar el trigger que sincronizaba reservas_horarios ← horario_* (delivery).
--    Si no, editar los horarios de la tienda pisaría los del salón.
DROP TRIGGER IF EXISTS sync_reservas_horarios ON public.comanda_local_settings;

-- 3. Validación al reservar: aceptar si la hora cae en CUALQUIER franja del día.
CREATE OR REPLACE FUNCTION public.fn_check_disponibilidad_reserva(p_local_slug text, p_fecha_hora timestamp with time zone, p_personas integer, p_zona text DEFAULT NULL::text)
 RETURNS TABLE(disponible boolean, motivo text, personas_actuales integer, capacidad_max integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
    v_abre := v_exc_abre; v_cierra := v_exc_cierra;
    IF v_cierra > v_abre THEN v_en_rango := v_hora >= v_abre AND v_hora <= v_cierra;
    ELSE v_en_rango := v_hora >= v_abre OR v_hora <= v_cierra; END IF;
    IF NOT v_en_rango THEN RETURN QUERY SELECT FALSE,'FUERA_DE_HORARIO',0,v_capacidad; RETURN; END IF;
  ELSIF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
    v_dow := EXTRACT(DOW FROM v_local_ts)::int;
    -- Recorre TODAS las franjas del día: en rango si la hora cae en CUALQUIERA
    -- (permite almuerzo + cena el mismo día). Sin EXIT.
    FOR v_dia IN SELECT * FROM jsonb_array_elements(v_horarios) LOOP
      IF (v_dia->>'dia')::int = v_dow THEN
        v_encontrado := TRUE;
        v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
        IF v_cierra > v_abre THEN
          v_en_rango := v_en_rango OR (v_hora >= v_abre AND v_hora <= v_cierra);
        ELSE
          v_en_rango := v_en_rango OR (v_hora >= v_abre OR v_hora <= v_cierra);
        END IF;
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

-- 4. Oferta de turnos: generar slots para CADA franja del día.
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
    IF v_exc_abre IS NULL OR v_exc_cierra IS NULL THEN RETURN; END IF;
    v_franjas := jsonb_build_array(jsonb_build_object(
      'abre', to_char(v_exc_abre,'HH24:MI'), 'cierra', to_char(v_exc_cierra,'HH24:MI')));
  ELSE
    v_dow := EXTRACT(DOW FROM p_fecha)::int;
    IF jsonb_typeof(v_horarios) = 'array' AND jsonb_array_length(v_horarios) > 0 THEN
      -- Todas las franjas del día, ordenadas por hora de apertura.
      SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'abre')), '[]'::jsonb) INTO v_franjas
        FROM jsonb_array_elements(v_horarios) e WHERE (e->>'dia')::int = v_dow;
      IF jsonb_array_length(v_franjas) = 0 THEN RETURN; END IF;  -- cerrado ese día
    ELSE
      v_franjas := jsonb_build_array(jsonb_build_object('abre','11:00','cierra','23:30'));
    END IF;
  END IF;

  v_dur := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  -- Una franja por iteración → almuerzo y cena generan sus propios turnos.
  FOR v_dia IN SELECT * FROM jsonb_array_elements(v_franjas) LOOP
    v_abre := (v_dia->>'abre')::time; v_cierra := (v_dia->>'cierra')::time;
    IF v_abre IS NULL OR v_cierra IS NULL THEN CONTINUE; END IF;
    v_cur := (EXTRACT(HOUR FROM v_abre) * 60 + EXTRACT(MINUTE FROM v_abre))::int;
    v_fin := (EXTRACT(HOUR FROM v_cierra) * 60 + EXTRACT(MINUTE FROM v_cierra))::int;
    IF v_fin <= v_cur THEN v_fin := 24 * 60; END IF;  -- cierre a/ pasada medianoche
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

-- 5. Perfil público: mostrar los horarios del SALÓN (reservas_horarios), armando
--    el string de cada día con sus franjas ("12:00 – 15:00 · 20:00 – 00:00").
CREATE OR REPLACE FUNCTION public.fn_get_perfil_publico_local(p_local_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cls comanda_local_settings%ROWTYPE;
  v_local_nombre text;
  v_tenant uuid;
  v_populares jsonb;
  v_reviews jsonb;
  v_reviews_resumen jsonb;
  v_eventos jsonb;
  v_giftcards jsonb;
  v_hermanos jsonb;
  v_hay_mesa boolean := NULL;
  v_horarios jsonb;
BEGIN
  SELECT cls.* INTO v_cls FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug AND cls.deleted_at IS NULL;
  IF v_cls.id IS NULL THEN RETURN NULL; END IF;

  SELECT l.nombre, l.tenant_id INTO v_local_nombre, v_tenant
    FROM locales l WHERE l.id = v_cls.local_id;

  SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO v_populares FROM (
    SELECT i.nombre, i.foto_url, i.precio_madre AS precio,
           SUM(vpi.cantidad)::numeric AS vendidos
      FROM ventas_pos_items vpi
      JOIN ventas_pos v ON v.id = vpi.venta_id
      JOIN items i ON i.id = vpi.item_id
     WHERE v.local_id = v_cls.local_id
       AND v.estado = 'cobrada'
       AND v.cobrada_at > NOW() - INTERVAL '30 days'
       AND vpi.deleted_at IS NULL AND vpi.estado <> 'anulado'
       AND i.deleted_at IS NULL
     GROUP BY i.id, i.nombre, i.foto_url, i.precio_madre
     ORDER BY SUM(vpi.cantidad) DESC
     LIMIT 6
  ) p;

  BEGIN
    SELECT jsonb_build_object(
             'promedio', MAX(r.rating_promedio),
             'total', MAX(r.total_reviews)
           ),
           COALESCE(jsonb_agg(jsonb_build_object(
             'autor', r.autor_nombre, 'rating', r.rating,
             'comentario', r.comentario, 'fecha', r.created_at
           )) FILTER (WHERE r.rn <= 3), '[]'::jsonb)
      INTO v_reviews_resumen, v_reviews
      FROM (
        SELECT x.*, row_number() OVER (ORDER BY x.created_at DESC) rn
          FROM fn_listar_reviews_publicas(p_local_slug) x
      ) r;
  EXCEPTION WHEN OTHERS THEN
    v_reviews_resumen := NULL;
    v_reviews := '[]'::jsonb;
  END;

  SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) INTO v_eventos
    FROM fn_eventos_publicos(p_local_slug) e;
  SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb) INTO v_giftcards
    FROM fn_giftcards_publicas(p_local_slug) g;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', h.slug, 'nombre', h.nombre, 'direccion', h.direccion)), '[]'::jsonb)
    INTO v_hermanos
    FROM (
      SELECT cls2.slug, l2.nombre, cls2.direccion
        FROM comanda_local_settings cls2
        JOIN locales l2 ON l2.id = cls2.local_id
       WHERE l2.tenant_id = v_tenant
         AND cls2.slug IS NOT NULL
         AND cls2.deleted_at IS NULL
         AND cls2.local_id != v_cls.local_id
         AND cls2.reservas_activas = true
       ORDER BY l2.nombre
    ) h;

  -- Horarios del SALÓN por día (varias franjas juntadas con " · ").
  SELECT jsonb_object_agg(d.k, t.v) INTO v_horarios
    FROM (VALUES ('lun',1),('mar',2),('mie',3),('jue',4),('vie',5),('sab',6),('dom',0)) AS d(k, dow)
    LEFT JOIN LATERAL (
      SELECT string_agg((e->>'abre') || ' – ' || (e->>'cierra'), ' · ' ORDER BY (e->>'abre')) AS v
        FROM jsonb_array_elements(COALESCE(v_cls.reservas_horarios, '[]'::jsonb)) e
       WHERE (e->>'dia')::int = d.dow
    ) t ON true;

  IF COALESCE(v_cls.reservas_activas, false) THEN
    BEGIN
      SELECT d.disponible INTO v_hay_mesa
        FROM fn_check_disponibilidad_reserva(p_local_slug, NOW(), 2) d;
    EXCEPTION WHEN OTHERS THEN
      v_hay_mesa := NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'local', jsonb_build_object(
      'nombre', v_local_nombre,
      'slug', v_cls.slug,
      'direccion', v_cls.direccion,
      'telefono', v_cls.telefono,
      'instagram', v_cls.instagram,
      'web', v_cls.web,
      'descripcion', v_cls.mesa_descripcion,
      'fotos', v_cls.mesa_fotos,
      'horarios', COALESCE(v_horarios, '{}'::jsonb)
    ),
    'reservas', jsonb_build_object(
      'activas', COALESCE(v_cls.reservas_activas, false),
      'anticipacion_min_hs', v_cls.reservas_anticipacion_min_hs,
      'anticipacion_max_dias', v_cls.reservas_anticipacion_max_dias,
      'telefono_obligatorio', COALESCE(v_cls.reservas_telefono_obligatorio, true),
      'email_obligatorio', COALESCE(v_cls.reservas_email_obligatorio, false),
      'excepciones', COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'fecha',   e.fecha,
                   'cerrado', e.cerrado,
                   'abre',    to_char(e.abre,   'HH24:MI'),
                   'cierra',  to_char(e.cierra, 'HH24:MI')
                 ) ORDER BY e.fecha)
        FROM reservas_excepciones e
        WHERE e.local_id = v_cls.local_id
          AND e.fecha >= (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
          AND e.fecha <= (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
                         + COALESCE(v_cls.reservas_anticipacion_max_dias, 30)
      ), '[]'::jsonb)
    ),
    'hay_mesa_ahora', v_hay_mesa,
    'populares', v_populares,
    'reviews', jsonb_build_object('resumen', COALESCE(v_reviews_resumen, '{}'::jsonb), 'ultimas', COALESCE(v_reviews, '[]'::jsonb)),
    'eventos', v_eventos,
    'giftcards', v_giftcards,
    'hermanos', v_hermanos
  );
END;
$function$;
