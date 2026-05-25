-- ─────────────────────────────────────────────────────────────────────────
-- tenant_features — feature flags por tenant (sprint 27-may noche).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Pedido Lucas 27-may: "quiero tener desde el admin de tenants una
-- interfaz similar a la de usuarios pero que sea de tenants y ahí poder
-- dejarles ver o ocultarles ciertas cosas, porque hay algunas que están
-- en fase de prueba y no quiero que las vean otras personas".
--
-- Modelo:
--   - Catálogo de features vive en TypeScript (`src/lib/features.ts`).
--     Cada feature tiene un `slug` único y un `default_habilitado` que
--     determina qué pasa si no hay fila explícita en `tenant_features`
--     para ese (tenant, slug).
--   - Esta tabla guarda solo OVERRIDES — filas explícitas por tenant.
--     Si Lucas no toca nada, el tenant ve los defaults del catálogo.
--   - Superadmin puede setear `habilitado=TRUE/FALSE` por tenant desde
--     2 UIs nuevas: detalle por tenant + matriz tenants × features.
--
-- Helper `auth_tenant_tiene_feature(slug, default_value)` se usa desde
-- RLS y desde el frontend (vía RPC `fn_tenant_tiene_feature`) para
-- consultar si el tenant actual tiene la feature habilitada.
--
-- RLS:
--   - SELECT: el propio tenant ve su fila, superadmin todas.
--   - INSERT/UPDATE/DELETE: solo superadmin.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_features (
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_slug TEXT NOT NULL,
  habilitado   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_slug)
);

COMMENT ON TABLE tenant_features IS
  'Feature flags por tenant. Solo guarda overrides — el catálogo y los '
  'defaults viven en src/lib/features.ts. Lucas/superadmin administra '
  'desde /tenants (UI detalle + matriz).';

-- Trigger touch updated_at
CREATE OR REPLACE FUNCTION fn_tenant_features_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_features_touch ON tenant_features;
CREATE TRIGGER trg_tenant_features_touch
  BEFORE UPDATE ON tenant_features
  FOR EACH ROW EXECUTE FUNCTION fn_tenant_features_touch();

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE tenant_features ENABLE ROW LEVEL SECURITY;

-- SELECT: cada tenant ve sus features + superadmin ve todas.
DROP POLICY IF EXISTS tenant_features_select ON tenant_features;
CREATE POLICY tenant_features_select ON tenant_features
  FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() OR auth_es_superadmin());

-- INSERT/UPDATE/DELETE: solo superadmin.
DROP POLICY IF EXISTS tenant_features_write ON tenant_features;
CREATE POLICY tenant_features_write ON tenant_features
  FOR ALL TO authenticated
  USING (auth_es_superadmin())
  WITH CHECK (auth_es_superadmin());

-- ─── Helper: chequear si el tenant actual tiene la feature ────────────
-- Devuelve TRUE/FALSE. Si NO hay fila override, usa el default_value
-- pasado por el caller (que viene del catálogo TS).
CREATE OR REPLACE FUNCTION auth_tenant_tiene_feature(
  p_slug TEXT,
  p_default BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := auth_tenant_id();
  v_habilitado BOOLEAN;
BEGIN
  -- Superadmin VE TODO (no le aplicamos restricciones de feature flag).
  IF auth_es_superadmin() THEN RETURN TRUE; END IF;

  IF v_tenant_id IS NULL THEN RETURN FALSE; END IF;

  SELECT habilitado INTO v_habilitado
  FROM tenant_features
  WHERE tenant_id = v_tenant_id AND feature_slug = p_slug;

  IF v_habilitado IS NULL THEN RETURN p_default; END IF;
  RETURN v_habilitado;
END;
$$;

COMMENT ON FUNCTION auth_tenant_tiene_feature IS
  'Chequea si el tenant actual tiene la feature habilitada. Si no hay '
  'override en tenant_features, devuelve el default del catálogo. '
  'Superadmin siempre devuelve TRUE.';

-- ─── RPC: bulk get features de un tenant (para UI detalle) ────────────
CREATE OR REPLACE FUNCTION fn_get_tenant_features(p_tenant_id UUID)
RETURNS TABLE (feature_slug TEXT, habilitado BOOLEAN, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() THEN RAISE EXCEPTION 'NOT_SUPERADMIN'; END IF;
  RETURN QUERY
    SELECT tf.feature_slug, tf.habilitado, tf.updated_at
    FROM tenant_features tf
    WHERE tf.tenant_id = p_tenant_id
    ORDER BY tf.feature_slug;
END;
$$;

-- ─── RPC: matrix de TODOS los tenants × features (para UI matriz) ─────
CREATE OR REPLACE FUNCTION fn_get_features_matrix()
RETURNS TABLE (tenant_id UUID, tenant_nombre TEXT, feature_slug TEXT, habilitado BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() THEN RAISE EXCEPTION 'NOT_SUPERADMIN'; END IF;
  RETURN QUERY
    SELECT t.id AS tenant_id, t.nombre AS tenant_nombre,
           tf.feature_slug, tf.habilitado
    FROM tenants t
    LEFT JOIN tenant_features tf ON tf.tenant_id = t.id
    WHERE t.activo = TRUE
    ORDER BY t.nombre, tf.feature_slug;
END;
$$;

-- ─── RPC: set un override (upsert) ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_set_tenant_feature(
  p_tenant_id UUID,
  p_slug TEXT,
  p_habilitado BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() THEN RAISE EXCEPTION 'NOT_SUPERADMIN'; END IF;

  INSERT INTO tenant_features (tenant_id, feature_slug, habilitado)
  VALUES (p_tenant_id, p_slug, p_habilitado)
  ON CONFLICT (tenant_id, feature_slug)
  DO UPDATE SET habilitado = EXCLUDED.habilitado, updated_at = now();

  -- Auditoría
  INSERT INTO auditoria (tabla, accion, detalle, tenant_id)
  VALUES ('tenant_features', 'SET', jsonb_build_object(
    'tenant_id', p_tenant_id,
    'slug', p_slug,
    'habilitado', p_habilitado
  )::text, p_tenant_id);
END;
$$;

-- ─── RPC: bulk set (más eficiente para "Activar todo" / "Resetear") ───
CREATE OR REPLACE FUNCTION fn_set_tenant_features_bulk(
  p_tenant_id UUID,
  p_features JSONB  -- ej: [{"slug":"modulo.caja","habilitado":true}, ...]
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_feat JSONB;
BEGIN
  IF NOT auth_es_superadmin() THEN RAISE EXCEPTION 'NOT_SUPERADMIN'; END IF;
  IF p_features IS NULL OR jsonb_typeof(p_features) <> 'array' THEN
    RAISE EXCEPTION 'BAD_PAYLOAD';
  END IF;

  FOR v_feat IN SELECT * FROM jsonb_array_elements(p_features)
  LOOP
    INSERT INTO tenant_features (tenant_id, feature_slug, habilitado)
    VALUES (
      p_tenant_id,
      v_feat->>'slug',
      (v_feat->>'habilitado')::BOOLEAN
    )
    ON CONFLICT (tenant_id, feature_slug)
    DO UPDATE SET habilitado = EXCLUDED.habilitado, updated_at = now();
  END LOOP;

  -- Audit
  INSERT INTO auditoria (tabla, accion, detalle, tenant_id)
  VALUES ('tenant_features', 'SET_BULK', jsonb_build_object(
    'tenant_id', p_tenant_id,
    'count', jsonb_array_length(p_features)
  )::text, p_tenant_id);
END;
$$;

-- ─── RPC: reset (borrar todos los overrides de un tenant — vuelve a defaults) ─
CREATE OR REPLACE FUNCTION fn_reset_tenant_features(p_tenant_id UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  IF NOT auth_es_superadmin() THEN RAISE EXCEPTION 'NOT_SUPERADMIN'; END IF;

  DELETE FROM tenant_features WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO auditoria (tabla, accion, detalle, tenant_id)
  VALUES ('tenant_features', 'RESET', jsonb_build_object(
    'tenant_id', p_tenant_id,
    'borradas', v_count
  )::text, p_tenant_id);

  RETURN v_count;
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION fn_get_tenant_features FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fn_get_features_matrix FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fn_set_tenant_feature FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fn_set_tenant_features_bulk FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fn_reset_tenant_features FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_get_tenant_features TO authenticated;
GRANT EXECUTE ON FUNCTION fn_get_features_matrix TO authenticated;
GRANT EXECUTE ON FUNCTION fn_set_tenant_feature TO authenticated;
GRANT EXECUTE ON FUNCTION fn_set_tenant_features_bulk TO authenticated;
GRANT EXECUTE ON FUNCTION fn_reset_tenant_features TO authenticated;

GRANT EXECUTE ON FUNCTION auth_tenant_tiene_feature TO authenticated;
