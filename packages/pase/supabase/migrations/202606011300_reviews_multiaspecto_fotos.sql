-- 202606011300_reviews_multiaspecto_fotos.sql
-- Brainstorm #8 Fase 5 Chunk C — Reseñas multi-aspecto + fotos.
--
-- Agrega:
--   1. 3 columnas opcionales para rating por aspecto (comida/entrega/
--      presentación). El rating global existente queda como fallback.
--   2. Columna foto_url para foto adjunta (Supabase Storage).
--   3. Bucket público marketplace_review_photos (2 MB, jpeg/png/webp).
--   4. Modifica fn_crear_review_publica para aceptar los 4 nuevos params.
--   5. Modifica fn_listar_reviews_publicas para devolverlos.
--
-- Back-compat: campos opcionales, vista pública existente sigue funcionando.

-- ─── 1. Columnas multi-aspecto + foto ────────────────────────────────────────
ALTER TABLE marketplace_reviews
  ADD COLUMN IF NOT EXISTS estrellas_comida SMALLINT NULL CHECK (estrellas_comida BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS estrellas_entrega SMALLINT NULL CHECK (estrellas_entrega BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS estrellas_presentacion SMALLINT NULL CHECK (estrellas_presentacion BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS foto_url TEXT NULL;

COMMENT ON COLUMN marketplace_reviews.estrellas_comida IS 'Rating 1-5 sabor/calidad comida (opcional, F5 Brainstorm #8)';
COMMENT ON COLUMN marketplace_reviews.estrellas_entrega IS 'Rating 1-5 puntualidad/estado entrega (opcional, F5)';
COMMENT ON COLUMN marketplace_reviews.estrellas_presentacion IS 'Rating 1-5 presentación del pedido (opcional, F5)';
COMMENT ON COLUMN marketplace_reviews.foto_url IS 'URL pública de foto adjunta en marketplace_review_photos bucket';

-- ─── 2. Bucket Supabase Storage público read, restringido write ──────────────
-- Las imágenes son públicas (cualquiera puede mostrarlas en cards). El upload
-- se permite a anon también porque el flow es desde la tienda pública.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketplace_review_photos',
  'marketplace_review_photos',
  TRUE,                                                  -- público read
  2097152,                                               -- 2 MB max
  ARRAY['image/jpeg','image/png','image/webp']           -- formatos aceptados
)
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 2097152,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

-- Policy upload: anon + authenticated pueden insertar (limitado por size+mime arriba)
DROP POLICY IF EXISTS "Anyone can upload review photo" ON storage.objects;
CREATE POLICY "Anyone can upload review photo" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'marketplace_review_photos');

-- Policy read: público (es público, no requiere policy adicional pero la dejamos explícita)
DROP POLICY IF EXISTS "Public read review photos" ON storage.objects;
CREATE POLICY "Public read review photos" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'marketplace_review_photos');

-- Policy delete: solo dueños del local (vía service role o admin). Anon NO borra.
DROP POLICY IF EXISTS "Admins can delete review photos" ON storage.objects;
CREATE POLICY "Admins can delete review photos" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'marketplace_review_photos'
    AND (auth_es_superadmin() OR auth_es_dueno_o_admin())
  );

-- ─── 3. Modificar fn_crear_review_publica con nuevos params ──────────────────
CREATE OR REPLACE FUNCTION fn_crear_review_publica(
  p_venta_id              BIGINT,
  p_telefono              TEXT,
  p_rating                SMALLINT,
  p_comentario            TEXT DEFAULT NULL,
  p_email                 TEXT DEFAULT NULL,
  p_estrellas_comida      SMALLINT DEFAULT NULL,
  p_estrellas_entrega     SMALLINT DEFAULT NULL,
  p_estrellas_presentacion SMALLINT DEFAULT NULL,
  p_foto_url              TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_review_id UUID;
  v_existente RECORD;
BEGIN
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'RATING_INVALIDO';
  END IF;
  IF p_telefono IS NULL OR length(trim(p_telefono)) = 0 THEN
    RAISE EXCEPTION 'TELEFONO_REQUERIDO';
  END IF;

  SELECT v.id, v.tenant_id, v.local_id, v.cliente_nombre, v.cliente_telefono, v.estado, v.origen
    INTO v_venta
    FROM ventas_pos v
   WHERE v.id = p_venta_id
     AND v.origen = 'tienda_online';

  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta.cliente_telefono IS DISTINCT FROM p_telefono THEN RAISE EXCEPTION 'TELEFONO_NO_COINCIDE'; END IF;
  IF v_venta.estado NOT IN ('entregada', 'cobrada') THEN RAISE EXCEPTION 'VENTA_NO_TERMINADA'; END IF;

  SELECT * INTO v_existente FROM marketplace_reviews WHERE venta_id = p_venta_id;
  IF v_existente.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'review_id', v_existente.id,
      'rating', v_existente.rating,
      'comentario', v_existente.comentario,
      'created_at', v_existente.created_at,
      'ya_existia', true
    );
  END IF;

  INSERT INTO marketplace_reviews (
    tenant_id, local_id, venta_id, autor_nombre, autor_telefono, autor_email,
    rating, comentario, moderacion_estado,
    estrellas_comida, estrellas_entrega, estrellas_presentacion, foto_url
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, v_venta.id,
    COALESCE(v_venta.cliente_nombre, 'Anónimo'), p_telefono, p_email,
    p_rating, NULLIF(trim(p_comentario), ''),
    'publicada',
    p_estrellas_comida, p_estrellas_entrega, p_estrellas_presentacion,
    NULLIF(trim(p_foto_url), '')
  ) RETURNING id INTO v_review_id;

  RETURN jsonb_build_object('review_id', v_review_id, 'ya_existia', false);
END;
$$;

REVOKE ALL ON FUNCTION fn_crear_review_publica(BIGINT, TEXT, SMALLINT, TEXT, TEXT, SMALLINT, SMALLINT, SMALLINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_crear_review_publica(BIGINT, TEXT, SMALLINT, TEXT, TEXT, SMALLINT, SMALLINT, SMALLINT, TEXT) TO anon, authenticated;

-- ─── 4. Modificar fn_listar_reviews_publicas para devolver nuevos campos ─────
-- DROP requerido porque cambia la signature del RETURNS TABLE (4 cols nuevas).
-- CREATE OR REPLACE no permite cambio de return type (error 42P13).
DROP FUNCTION IF EXISTS fn_listar_reviews_publicas(TEXT);
CREATE OR REPLACE FUNCTION fn_listar_reviews_publicas(p_local_slug TEXT)
RETURNS TABLE (
  review_id UUID,
  autor_nombre TEXT,
  rating SMALLINT,
  comentario TEXT,
  created_at TIMESTAMPTZ,
  total_reviews BIGINT,
  rating_promedio NUMERIC,
  estrellas_comida SMALLINT,
  estrellas_entrega SMALLINT,
  estrellas_presentacion SMALLINT,
  foto_url TEXT
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT count(*), avg(rating)::numeric(3,2)
    INTO v_total, v_avg
    FROM marketplace_reviews
   WHERE local_id = v_local_id AND moderacion_estado = 'publicada';

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
$$;

GRANT EXECUTE ON FUNCTION fn_listar_reviews_publicas(TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
