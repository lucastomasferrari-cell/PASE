-- I1 (auditoría): fn_asignar_mesa_reserva (asignación manual desde el admin)
-- no chequeaba si la mesa ya estaba ocupada en la ventana ni tomaba lock →
-- una asignación manual y un alta pública podían agarrar la misma mesa a la
-- vez (doble-booking). Ahora: mismo advisory lock por local que el alta
-- pública + chequeo de solapamiento (fn_mesa_ocupada_en). También setea
-- mesas_ids para que el motor lo vea consistente.
CREATE OR REPLACE FUNCTION public.fn_asignar_mesa_reserva(p_reserva_id bigint, p_mesa_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_actual UUID := auth_tenant_id();
  v_local_reserva INTEGER; v_local_mesa INTEGER;
  v_tenant_reserva UUID; v_estado TEXT; v_fecha timestamptz; v_dur integer;
BEGIN
  SELECT local_id, tenant_id, estado, fecha_hora, COALESCE(duracion_min, 90)
    INTO v_local_reserva, v_tenant_reserva, v_estado, v_fecha, v_dur
    FROM reservas WHERE id = p_reserva_id;
  IF v_local_reserva IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF v_tenant_reserva != v_tenant_actual THEN RAISE EXCEPTION 'RESERVA_OTRO_TENANT'; END IF;
  IF v_estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ASIGNABLE: estado=%', v_estado;
  END IF;
  SELECT local_id INTO v_local_mesa FROM mesas WHERE id = p_mesa_id;
  IF v_local_mesa IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
  IF v_local_mesa != v_local_reserva THEN RAISE EXCEPTION 'MESA_OTRO_LOCAL'; END IF;

  PERFORM pg_advisory_xact_lock(v_local_reserva::bigint);
  IF fn_mesa_ocupada_en(p_mesa_id, v_fecha, v_dur, p_reserva_id) THEN
    RAISE EXCEPTION 'MESA_OCUPADA';
  END IF;

  UPDATE reservas SET mesa_id = p_mesa_id, mesas_ids = ARRAY[p_mesa_id], updated_at = NOW()
   WHERE id = p_reserva_id;
END;
$function$;
