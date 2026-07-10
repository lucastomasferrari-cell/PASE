-- ============================================================
-- 202607100100_asignar_mesa_valida_cap_min.sql
-- fn_asignar_mesa_reserva y fn_editar_reserva ahora VALIDAN que la
-- reserva no exceda la CAPACIDAD MÁXIMA de la mesa. El mínimo queda
-- flexible desde admin (el dueño puede querer sentar 2 en un sillón
-- de 4 si sobra lugar). El máximo es SIEMPRE duro — jamás x8 en cap 6.
--
-- Reporte Lucas 10-jul (Guilherme x8 en Sillón 7 cap 6, asignado
-- manualmente sin validación).
-- ============================================================

BEGIN;

-- ============================================================
-- fn_asignar_mesa_reserva: cap duro
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_asignar_mesa_reserva(
  p_reserva_id bigint, p_mesa_id bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_actual UUID := auth_tenant_id();
  v_local_reserva INTEGER; v_local_mesa INTEGER;
  v_tenant_reserva UUID; v_estado TEXT;
  v_fecha timestamptz; v_dur integer;
  v_personas integer;
  v_cap integer;
BEGIN
  SELECT local_id, tenant_id, estado, fecha_hora, COALESCE(duracion_min, 90), personas
    INTO v_local_reserva, v_tenant_reserva, v_estado, v_fecha, v_dur, v_personas
    FROM reservas WHERE id = p_reserva_id;
  IF v_local_reserva IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF v_tenant_reserva != v_tenant_actual THEN RAISE EXCEPTION 'RESERVA_OTRO_TENANT'; END IF;
  IF v_estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ASIGNABLE: estado=%', v_estado;
  END IF;

  SELECT local_id, COALESCE(capacidad, 0)
    INTO v_local_mesa, v_cap
    FROM mesas WHERE id = p_mesa_id AND deleted_at IS NULL;
  IF v_local_mesa IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
  IF v_local_mesa != v_local_reserva THEN RAISE EXCEPTION 'MESA_OTRO_LOCAL'; END IF;

  -- CAP DURO: nunca podés meter más personas de las que entran en la mesa.
  -- El mínimo NO se valida acá: admin decide (ej. 2 pax en un sillón de 4).
  IF v_personas > v_cap THEN
    RAISE EXCEPTION 'MESA_SIN_CAPACIDAD: mesa cap=% personas=%', v_cap, v_personas;
  END IF;

  PERFORM pg_advisory_xact_lock(v_local_reserva::bigint);
  IF fn_mesa_ocupada_en(p_mesa_id, v_fecha, v_dur, p_reserva_id) THEN
    RAISE EXCEPTION 'MESA_OCUPADA';
  END IF;

  UPDATE reservas SET mesa_id = p_mesa_id, mesas_ids = ARRAY[p_mesa_id], updated_at = NOW()
   WHERE id = p_reserva_id;
END; $function$;


-- ============================================================
-- fn_editar_reserva: si cambia personas, revalida cap de la(s) mesa(s) actual(es)
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_editar_reserva(
  p_reserva_id bigint,
  p_cliente_nombre text DEFAULT NULL,
  p_cliente_telefono text DEFAULT NULL,
  p_cliente_email text DEFAULT NULL,
  p_fecha_hora timestamp with time zone DEFAULT NULL,
  p_personas integer DEFAULT NULL,
  p_notas text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_r reservas%ROWTYPE;
  v_new_fecha timestamptz;
  v_new_personas integer;
  v_new_dur integer;
  v_revalidar boolean := false;
  v_clear_mesa boolean := false;
  v_m bigint;
  v_cap_total integer;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF v_r.estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_EDITABLE';
  END IF;

  IF p_cliente_nombre IS NOT NULL AND trim(p_cliente_nombre) = '' THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;
  IF p_personas IS NOT NULL AND (p_personas < 1 OR p_personas > 50) THEN
    RAISE EXCEPTION 'PERSONAS_INVALIDAS';
  END IF;
  IF p_fecha_hora IS NOT NULL AND p_fecha_hora < NOW() - INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'FECHA_PASADA';
  END IF;

  v_new_fecha := COALESCE(p_fecha_hora, v_r.fecha_hora);
  v_new_personas := COALESCE(p_personas, v_r.personas);
  v_revalidar := (p_fecha_hora IS NOT NULL AND p_fecha_hora <> v_r.fecha_hora)
              OR (p_personas IS NOT NULL AND p_personas <> v_r.personas);

  -- CAP DURO: si sube personas y la(s) mesa(s) asignada(s) NO alcanzan,
  -- rechazar. Antes esto pasaba silenciosamente (x4 → x8 en cap 6 = OVER_CAP).
  IF p_personas IS NOT NULL AND p_personas <> v_r.personas
     AND (v_r.mesa_id IS NOT NULL OR array_length(v_r.mesas_ids, 1) IS NOT NULL) THEN
    SELECT COALESCE(SUM(COALESCE(m.capacidad, 0)), 0) INTO v_cap_total
    FROM mesas m
    WHERE m.id = ANY(COALESCE(NULLIF(v_r.mesas_ids, '{}'), ARRAY[v_r.mesa_id]))
      AND m.deleted_at IS NULL;
    IF p_personas > v_cap_total THEN
      RAISE EXCEPTION 'MESA_SIN_CAPACIDAD: mesa(s) cap=% personas=%', v_cap_total, p_personas;
    END IF;
  END IF;

  IF v_revalidar THEN
    v_new_dur := COALESCE(fn_duracion_reserva_default(v_r.local_id, v_new_personas), v_r.duracion_min, 90);
    PERFORM pg_advisory_xact_lock(v_r.local_id::bigint);
    IF v_r.mesas_ids IS NOT NULL AND array_length(v_r.mesas_ids, 1) IS NOT NULL THEN
      FOREACH v_m IN ARRAY v_r.mesas_ids LOOP
        IF fn_mesa_ocupada_en(v_m, v_new_fecha, v_new_dur, v_r.id) THEN v_clear_mesa := TRUE; END IF;
      END LOOP;
    ELSIF v_r.mesa_id IS NOT NULL THEN
      IF fn_mesa_ocupada_en(v_r.mesa_id, v_new_fecha, v_new_dur, v_r.id) THEN v_clear_mesa := TRUE; END IF;
    END IF;
  END IF;

  UPDATE reservas SET
    cliente_nombre   = COALESCE(NULLIF(trim(COALESCE(p_cliente_nombre, '')), ''), cliente_nombre),
    cliente_telefono = CASE WHEN p_cliente_telefono IS NULL THEN cliente_telefono
                            ELSE NULLIF(trim(p_cliente_telefono), '') END,
    cliente_email    = CASE WHEN p_cliente_email IS NULL THEN cliente_email
                            ELSE NULLIF(trim(p_cliente_email), '') END,
    fecha_hora = COALESCE(p_fecha_hora, fecha_hora),
    personas   = COALESCE(p_personas, personas),
    duracion_min = CASE WHEN p_personas IS NOT NULL AND p_personas <> v_r.personas
                        THEN fn_duracion_reserva_default(v_r.local_id, p_personas)
                        ELSE duracion_min END,
    mesa_id   = CASE WHEN v_clear_mesa THEN NULL ELSE mesa_id END,
    mesas_ids = CASE WHEN v_clear_mesa THEN NULL ELSE mesas_ids END,
    notas      = CASE WHEN p_notas IS NULL THEN notas ELSE NULLIF(trim(p_notas), '') END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END; $function$;

COMMIT;
