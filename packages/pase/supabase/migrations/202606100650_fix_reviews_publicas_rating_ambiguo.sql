-- ════════════════════════════════════════════════════════════════════════
-- Fix bug de prod en fn_listar_reviews_publicas (09-jun, encontrado al
-- construir el perfil público de MESA): `avg(rating)` sin calificar es
-- ambiguo entre la COLUMNA marketplace_reviews.rating y el parámetro OUT
-- `rating` del RETURNS TABLE → la RPC explotaba para CUALQUIER local que
-- tuviera al menos 1 review publicada (Neko VC tiene 86). Nunca saltó en
-- tests porque los locales de prueba no tienen reviews.
-- Fix: alias de tabla + columna calificada.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_listar_reviews_publicas(p_local_slug text)
 RETURNS TABLE(review_id uuid, autor_nombre text, rating smallint, comentario text, created_at timestamp with time zone, total_reviews bigint, rating_promedio numeric, estrellas_comida smallint, estrellas_entrega smallint, estrellas_presentacion smallint, foto_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_local_id INTEGER;
  v_total BIGINT;
  v_avg NUMERIC;
BEGIN
  SELECT cls.local_id INTO v_local_id
    FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug
     AND cls.tienda_activa = TRUE
     AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  -- Columna calificada con alias — sin esto, `rating` era ambiguo contra el
  -- parámetro OUT homónimo y la función fallaba con reviews reales.
  SELECT count(*), avg(mr.rating)::numeric(3,2)
    INTO v_total, v_avg
    FROM marketplace_reviews mr
   WHERE mr.local_id = v_local_id AND mr.moderacion_estado = 'publicada';

  RETURN QUERY
  SELECT
    r.id AS review_id,
    CASE
      WHEN position(' ' in r.autor_nombre) > 0 THEN
        split_part(r.autor_nombre, ' ', 1) || ' ' ||
        upper(substring(split_part(r.autor_nombre, ' ', 2) from 1 for 1)) || '.'
      ELSE r.autor_nombre
    END AS autor_nombre,
    r.rating,
    r.comentario,
    r.created_at,
    v_total AS total_reviews,
    v_avg AS rating_promedio,
    r.estrellas_comida,
    r.estrellas_entrega,
    r.estrellas_presentacion,
    r.foto_url
  FROM marketplace_reviews r
  WHERE r.local_id = v_local_id AND r.moderacion_estado = 'publicada'
  ORDER BY r.created_at DESC
  LIMIT 50;
END;
$function$;
