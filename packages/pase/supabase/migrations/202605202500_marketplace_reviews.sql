-- ═══════════════════════════════════════════════════════════════════════════
-- Marketplace Gap #3: Reviews / Ratings públicos
--
-- Lucas 2026-05-19: cuando un cliente termina un pedido (estado=entregada),
-- puede dejar una review con rating 1-5 + comentario opcional. El restaurante
-- ve un promedio en su card del marketplace y los comentarios en su tienda.
--
-- Anti-abuso:
--   - Review solo se puede crear si la venta existe + está en estado
--     entregada/cobrada + el teléfono del autor matchea el de la venta.
--   - Una review por venta (UNIQUE constraint).
--   - Moderación: el dueño puede ocultar reviews ofensivas (moderacion_estado).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id        INTEGER NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
  venta_id        BIGINT NOT NULL REFERENCES ventas_pos(id) ON DELETE CASCADE,
  autor_nombre    TEXT NOT NULL,
  autor_telefono  TEXT NOT NULL,   -- match contra la venta (anti-abuso)
  autor_email     TEXT,
  rating          SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comentario      TEXT,
  moderacion_estado TEXT NOT NULL DEFAULT 'publicada'
                    CHECK (moderacion_estado IN ('publicada','oculta','reportada')),
  moderacion_motivo TEXT,
  moderado_por    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  moderado_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- UNA review por venta: si el cliente reintenta, recibe el resultado cacheado.
  CONSTRAINT marketplace_reviews_venta_unique UNIQUE (venta_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_reviews_local_publicadas
  ON marketplace_reviews (local_id, created_at DESC)
  WHERE moderacion_estado = 'publicada';

CREATE INDEX IF NOT EXISTS idx_mp_reviews_tenant_moderacion
  ON marketplace_reviews (tenant_id, moderacion_estado, created_at DESC);

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_reviews ENABLE ROW LEVEL SECURITY;

-- SELECT público: cualquiera puede ver reviews PUBLICADAS de cualquier local
-- (lo necesita el marketplace y la tienda /tienda/:slug públicos).
DROP POLICY IF EXISTS marketplace_reviews_select_public ON marketplace_reviews;
CREATE POLICY marketplace_reviews_select_public ON marketplace_reviews
  FOR SELECT TO anon, authenticated
  USING (moderacion_estado = 'publicada');

-- SELECT del dueño/admin del local: ve TODAS las reviews (incluyendo ocultas
-- y reportadas) de su tenant.
DROP POLICY IF EXISTS marketplace_reviews_select_owner ON marketplace_reviews;
CREATE POLICY marketplace_reviews_select_owner ON marketplace_reviews
  FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

-- UPDATE solo dueño/admin (moderar — cambiar moderacion_estado).
DROP POLICY IF EXISTS marketplace_reviews_update ON marketplace_reviews;
CREATE POLICY marketplace_reviews_update ON marketplace_reviews
  FOR UPDATE TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

-- INSERT solo via RPC (no abrimos a anon/authenticated directo). Default deny.

-- ─── RPC: crear review pública ─────────────────────────────────────────────
-- El cliente la llama desde /tienda/:slug/confirmacion/:ventaId después
-- de que el pedido pasó a entregada. SECURITY DEFINER porque tiene que
-- validar contra ventas_pos y persistir en tabla con RLS.
CREATE OR REPLACE FUNCTION fn_crear_review_publica(
  p_venta_id      BIGINT,
  p_telefono      TEXT,
  p_rating        SMALLINT,
  p_comentario    TEXT DEFAULT NULL,
  p_email         TEXT DEFAULT NULL
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

  -- Buscar venta y validar acceso por teléfono.
  SELECT v.id, v.tenant_id, v.local_id, v.cliente_nombre, v.cliente_telefono, v.estado, v.origen
    INTO v_venta
    FROM ventas_pos v
   WHERE v.id = p_venta_id
     AND v.origen = 'tienda_online';

  IF v_venta IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

  -- Anti-abuso: el teléfono debe coincidir con el de la venta.
  IF v_venta.cliente_telefono IS DISTINCT FROM p_telefono THEN
    RAISE EXCEPTION 'TELEFONO_NO_COINCIDE';
  END IF;

  -- La venta debe estar terminada.
  IF v_venta.estado NOT IN ('entregada', 'cobrada') THEN
    RAISE EXCEPTION 'VENTA_NO_TERMINADA';
  END IF;

  -- Ya existe review para esta venta? Devolvemos la existente (idempotente).
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
    rating, comentario, moderacion_estado
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, v_venta.id,
    COALESCE(v_venta.cliente_nombre, 'Anónimo'), p_telefono, p_email,
    p_rating, NULLIF(trim(p_comentario), ''),
    'publicada'  -- publicada de entrada, el dueño puede ocultarla si es ofensiva.
  ) RETURNING id INTO v_review_id;

  RETURN jsonb_build_object('review_id', v_review_id, 'ya_existia', false);
END;
$$;

-- ─── RPC: listar reviews públicas de un local ──────────────────────────────
-- Devuelve hasta 50 reviews publicadas + el resumen (avg rating + count).
CREATE OR REPLACE FUNCTION fn_listar_reviews_publicas(p_local_slug TEXT)
RETURNS TABLE (
  review_id UUID,
  autor_nombre TEXT,
  rating SMALLINT,
  comentario TEXT,
  created_at TIMESTAMPTZ,
  total_reviews BIGINT,
  rating_promedio NUMERIC
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

  -- Resumen agregado
  SELECT count(*), avg(rating)::numeric(3,2)
    INTO v_total, v_avg
    FROM marketplace_reviews
   WHERE local_id = v_local_id
     AND moderacion_estado = 'publicada';

  RETURN QUERY
  SELECT
    r.id AS review_id,
    -- Anonimizamos parcialmente el nombre: "Juan P." en vez de "Juan Pérez"
    -- para que sea legible pero no doxxee.
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
    v_avg AS rating_promedio
  FROM marketplace_reviews r
  WHERE r.local_id = v_local_id
    AND r.moderacion_estado = 'publicada'
  ORDER BY r.created_at DESC
  LIMIT 50;
END;
$$;

-- ─── RPC: moderar review (dueño/admin) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_moderar_review(
  p_review_id    UUID,
  p_nuevo_estado TEXT,
  p_motivo       TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review RECORD;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_nuevo_estado NOT IN ('publicada','oculta','reportada') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO';
  END IF;

  SELECT * INTO v_review FROM marketplace_reviews WHERE id = p_review_id;
  IF v_review IS NULL THEN RAISE EXCEPTION 'REVIEW_NO_ENCONTRADA'; END IF;
  IF v_review.tenant_id != auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: review de otro tenant';
  END IF;

  UPDATE marketplace_reviews
     SET moderacion_estado = p_nuevo_estado,
         moderacion_motivo = NULLIF(trim(COALESCE(p_motivo, '')), ''),
         moderado_por = auth_usuario_id(),
         moderado_at = now()
   WHERE id = p_review_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION fn_crear_review_publica(BIGINT, TEXT, SMALLINT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_listar_reviews_publicas(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_moderar_review(UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION fn_moderar_review(UUID, TEXT, TEXT) FROM anon;

-- ─── Vista agregada para el listing del marketplace (rating promedio + count) ─
-- Lo usa fn_marketplace_listar para enriquecer los locales sin N+1 queries.
CREATE OR REPLACE VIEW v_locales_rating_resumen AS
SELECT
  local_id,
  count(*) AS total_reviews,
  avg(rating)::numeric(3,2) AS rating_promedio,
  -- Distribución para mostrar histograma (opcional, low-priority).
  count(*) FILTER (WHERE rating = 5) AS stars_5,
  count(*) FILTER (WHERE rating = 4) AS stars_4,
  count(*) FILTER (WHERE rating = 3) AS stars_3,
  count(*) FILTER (WHERE rating = 2) AS stars_2,
  count(*) FILTER (WHERE rating = 1) AS stars_1
FROM marketplace_reviews
WHERE moderacion_estado = 'publicada'
GROUP BY local_id;

GRANT SELECT ON v_locales_rating_resumen TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
