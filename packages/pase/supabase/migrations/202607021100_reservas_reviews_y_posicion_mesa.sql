-- (1) Reseñas de RESERVAS (dine-in), no solo de ventas de la tienda online.
--     marketplace_reviews estaba atada a venta_id NOT NULL (origen tienda_online).
--     Se permite además una reseña ligada a una reserva finalizada, verificada
--     por el teléfono de la reserva.
ALTER TABLE marketplace_reviews ALTER COLUMN venta_id DROP NOT NULL;
ALTER TABLE marketplace_reviews ADD COLUMN IF NOT EXISTS reserva_id bigint;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_reserva
  ON marketplace_reviews(reserva_id) WHERE reserva_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_crear_review_reserva(
  p_reserva_id bigint, p_telefono text, p_rating smallint,
  p_comentario text DEFAULT NULL, p_email text DEFAULT NULL,
  p_estrellas_comida smallint DEFAULT NULL, p_estrellas_presentacion smallint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_r RECORD; v_id uuid; v_ex uuid;
BEGIN
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'RATING_INVALIDO'; END IF;
  IF p_telefono IS NULL OR length(trim(p_telefono)) = 0 THEN RAISE EXCEPTION 'TELEFONO_REQUERIDO'; END IF;

  SELECT id, tenant_id, local_id, cliente_nombre, cliente_telefono, estado
    INTO v_r FROM reservas WHERE id = p_reserva_id AND deleted_at IS NULL;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF fn_normalizar_telefono(v_r.cliente_telefono) IS DISTINCT FROM fn_normalizar_telefono(p_telefono) THEN
    RAISE EXCEPTION 'TELEFONO_NO_COINCIDE';
  END IF;
  IF v_r.estado NOT IN ('sentada', 'finalizada') THEN RAISE EXCEPTION 'RESERVA_NO_ELEGIBLE'; END IF;

  SELECT id INTO v_ex FROM marketplace_reviews WHERE reserva_id = p_reserva_id;
  IF v_ex IS NOT NULL THEN RETURN jsonb_build_object('review_id', v_ex, 'ya_existia', true); END IF;

  INSERT INTO marketplace_reviews (
    tenant_id, local_id, reserva_id, autor_nombre, autor_telefono, autor_email,
    rating, comentario, moderacion_estado, estrellas_comida, estrellas_presentacion
  ) VALUES (
    v_r.tenant_id, v_r.local_id, v_r.id, COALESCE(v_r.cliente_nombre, 'Anónimo'),
    p_telefono, NULLIF(trim(p_email), ''), p_rating, NULLIF(trim(p_comentario), ''),
    'publicada', p_estrellas_comida, p_estrellas_presentacion
  ) RETURNING id INTO v_id;
  RETURN jsonb_build_object('review_id', v_id, 'ya_existia', false);
END; $$;

REVOKE ALL ON FUNCTION public.fn_crear_review_reserva(bigint, text, smallint, text, text, smallint, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_crear_review_reserva(bigint, text, smallint, text, text, smallint, smallint) TO anon, authenticated, service_role;

-- (2) Ubicar mesas desde MESA: guardar posición en el plano (pos_x/pos_y).
--     RPC con auth propio para no depender del permiso granular
--     'comanda.mesas.gestionar' del policy de escritura de mesas.
CREATE OR REPLACE FUNCTION public.fn_mesa_posicion(p_mesa_id bigint, p_x integer, p_y integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_local integer; v_mtenant uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT local_id, tenant_id INTO v_local, v_mtenant FROM mesas WHERE id = p_mesa_id AND deleted_at IS NULL;
  IF v_local IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
  IF v_mtenant IS DISTINCT FROM v_tenant THEN RAISE EXCEPTION 'MESA_OTRO_TENANT'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  UPDATE mesas SET pos_x = p_x, pos_y = p_y WHERE id = p_mesa_id;
END; $$;

REVOKE ALL ON FUNCTION public.fn_mesa_posicion(bigint, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_mesa_posicion(bigint, integer, integer) TO authenticated, service_role;
