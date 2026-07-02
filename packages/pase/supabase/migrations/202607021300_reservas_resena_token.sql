-- Reseña por LINK con token (mismo cancel_token de la reserva) → sin teléfono.
-- + columna para no mandar el mail de reseña dos veces.
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS notif_resena_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_crear_review_token(
  p_reserva_id bigint, p_token uuid, p_rating smallint,
  p_comentario text DEFAULT NULL,
  p_estrellas_comida smallint DEFAULT NULL, p_estrellas_presentacion smallint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r RECORD; v_id uuid; v_ex uuid;
BEGIN
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'RATING_INVALIDO'; END IF;

  SELECT id, tenant_id, local_id, cliente_nombre, estado
    INTO v_r FROM reservas WHERE id = p_reserva_id AND cancel_token = p_token AND deleted_at IS NULL;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF v_r.estado NOT IN ('sentada', 'finalizada') THEN RAISE EXCEPTION 'RESERVA_NO_ELEGIBLE'; END IF;

  SELECT id INTO v_ex FROM marketplace_reviews WHERE reserva_id = p_reserva_id;
  IF v_ex IS NOT NULL THEN RETURN jsonb_build_object('review_id', v_ex, 'ya_existia', true); END IF;

  INSERT INTO marketplace_reviews (
    tenant_id, local_id, reserva_id, autor_nombre, autor_telefono,
    rating, comentario, moderacion_estado, estrellas_comida, estrellas_presentacion
  ) VALUES (
    v_r.tenant_id, v_r.local_id, v_r.id, COALESCE(v_r.cliente_nombre, 'Anónimo'), NULL,
    p_rating, NULLIF(trim(p_comentario), ''), 'publicada', p_estrellas_comida, p_estrellas_presentacion
  ) RETURNING id INTO v_id;
  RETURN jsonb_build_object('review_id', v_id, 'ya_existia', false);
END; $$;

-- autor_telefono es NOT NULL en el modelo viejo (ventas online). Para reseñas de
-- reserva por token no hay tel → lo permitimos nulo.
ALTER TABLE marketplace_reviews ALTER COLUMN autor_telefono DROP NOT NULL;

REVOKE ALL ON FUNCTION public.fn_crear_review_token(bigint, uuid, smallint, text, smallint, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_crear_review_token(bigint, uuid, smallint, text, smallint, smallint) TO anon, authenticated, service_role;
