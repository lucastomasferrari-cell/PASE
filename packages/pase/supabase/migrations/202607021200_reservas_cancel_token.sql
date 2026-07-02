-- Cancelación por LINK con token (sin pedir teléfono). El mail/confirmación
-- llevan un token secreto por reserva; el cliente entra, ve su reserva, pone
-- motivo y confirma. El token evita que se pueda cancelar por adivinar el id.
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cancel_token uuid;
UPDATE reservas SET cancel_token = gen_random_uuid() WHERE cancel_token IS NULL;
ALTER TABLE reservas ALTER COLUMN cancel_token SET DEFAULT gen_random_uuid();
ALTER TABLE reservas ALTER COLUMN cancel_token SET NOT NULL;

-- Traer el token de una reserva recién creada, verificando por teléfono
-- (lo usa la pantalla de confirmación: el cliente acaba de tipear su tel).
CREATE OR REPLACE FUNCTION public.fn_reserva_token_por_tel(p_reserva_id bigint, p_telefono text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.cancel_token FROM reservas r
   WHERE r.id = p_reserva_id AND r.deleted_at IS NULL
     AND fn_normalizar_telefono(r.cliente_telefono) IS NOT DISTINCT FROM fn_normalizar_telefono(p_telefono)
   LIMIT 1;
$$;

-- Resumen de la reserva para mostrar en la página de cancelación (id + token).
CREATE OR REPLACE FUNCTION public.fn_reserva_publica_token(p_reserva_id bigint, p_token uuid)
RETURNS TABLE(cliente_nombre text, fecha_hora timestamptz, personas integer, estado text, local_nombre text, cancelable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.cliente_nombre, r.fecha_hora, r.personas, r.estado,
         l.nombre, (r.estado IN ('pendiente','confirmada'))
    FROM reservas r JOIN locales l ON l.id = r.local_id
   WHERE r.id = p_reserva_id AND r.cancel_token = p_token AND r.deleted_at IS NULL;
$$;

-- Cancelar por token (sin teléfono). true = cancelada.
CREATE OR REPLACE FUNCTION public.fn_cancelar_reserva_token(p_reserva_id bigint, p_token uuid, p_motivo text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n integer;
BEGIN
  UPDATE reservas SET
    estado = 'cancelada',
    motivo_cancelacion = NULLIF(trim(p_motivo), ''),
    cancelada_por_cliente = TRUE,
    cancelada_at = NOW(),
    updated_at = NOW()
  WHERE id = p_reserva_id AND cancel_token = p_token
    AND estado IN ('pendiente','confirmada') AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END; $$;

-- Fix: la cancelación por teléfono (fallback) comparaba exacto → fallaba si el
-- número estaba guardado con otro formato. Ahora normaliza ambos lados.
CREATE OR REPLACE FUNCTION public.fn_cancelar_reserva_publica(p_reserva_id bigint, p_telefono text, p_motivo text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_n integer;
BEGIN
  UPDATE reservas SET
    estado = 'cancelada',
    motivo_cancelacion = NULLIF(trim(p_motivo), ''),
    cancelada_por_cliente = TRUE,
    cancelada_at = NOW(),
    updated_at = NOW()
  WHERE id = p_reserva_id
    AND fn_normalizar_telefono(cliente_telefono) IS NOT DISTINCT FROM fn_normalizar_telefono(p_telefono)
    AND estado IN ('pendiente','confirmada') AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END; $$;

REVOKE ALL ON FUNCTION public.fn_reserva_token_por_tel(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_reserva_publica_token(bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cancelar_reserva_token(bigint, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_reserva_token_por_tel(bigint, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_reserva_publica_token(bigint, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cancelar_reserva_token(bigint, uuid, text) TO anon, authenticated, service_role;
