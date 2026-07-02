-- Al EDITAR una reserva (fecha/hora o personas), re-validar la mesa asignada.
-- Antes fn_editar_reserva cambiaba fecha_hora sin re-chequear la mesa → mover una
-- reserva sobre el horario de otra dejaba dos reservas activas en la misma mesa
-- (doble booking silencioso). Ahora: si tras el cambio la banqueta/mesa que tenía
-- quedaría solapada con otra reserva activa, se suelta (mesa_id/mesas_ids = NULL)
-- para reasignación manual. Nunca bloquea el edit y nunca dobla una mesa.
CREATE OR REPLACE FUNCTION public.fn_editar_reserva(p_reserva_id bigint, p_cliente_nombre text DEFAULT NULL::text, p_cliente_telefono text DEFAULT NULL::text, p_cliente_email text DEFAULT NULL::text, p_fecha_hora timestamp with time zone DEFAULT NULL::timestamp with time zone, p_personas integer DEFAULT NULL::integer, p_notas text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

  -- ¿cambió algo que afecte el solapamiento de la mesa?
  v_new_fecha := COALESCE(p_fecha_hora, v_r.fecha_hora);
  v_new_personas := COALESCE(p_personas, v_r.personas);
  v_revalidar := (p_fecha_hora IS NOT NULL AND p_fecha_hora <> v_r.fecha_hora)
              OR (p_personas IS NOT NULL AND p_personas <> v_r.personas);

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
END;
$function$;
