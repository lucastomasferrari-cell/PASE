-- ═══════════════════════════════════════════════════════════════════════════
-- Marketing — integración Meta (Pixel + Conversions API) POR CLIENTE
-- Sesión 2026-07-28
--
-- Cada tenant (restaurante) configura SU Pixel de Meta y SU token de
-- Conversions API desde Habitué → Integraciones. No son env vars globales:
-- es multi-cliente, cada uno pone lo suyo.
--
-- - meta_pixel_id: NO es secreto (va embebido en la web pública). La página
--   pública (mesa) lo lee vía fn_meta_pixel_publico (definer, anon) para
--   disparar el Pixel del cliente.
-- - meta_capi_token: SÍ es secreto (permite mandar conversiones server-side).
--   Protegido con GRANT a nivel de columna: sólo service_role lo lee. El
--   endpoint de Conversions API lo usa server-side. NUNCA llega al browser.
--
-- Se escribe con la RPC fn_upsert_marketing_meta (SECURITY DEFINER, valida
-- dueño/admin del tenant), mismo patrón que afip_credenciales.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketing_integraciones (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Meta (Facebook/Instagram)
  meta_pixel_id        TEXT NULL,      -- público (embebido en la web)
  meta_capi_token      TEXT NULL,      -- SECRETO (solo service_role)
  meta_test_event_code TEXT NULL,      -- opcional, para "Test Events" de Meta
  meta_activa          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_mkt_integ_set_updated_at
  BEFORE UPDATE ON marketing_integraciones
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE marketing_integraciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_integ_select ON marketing_integraciones;
CREATE POLICY mkt_integ_select ON marketing_integraciones FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

DROP POLICY IF EXISTS mkt_integ_service ON marketing_integraciones;
CREATE POLICY mkt_integ_service ON marketing_integraciones FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- El token secreto NO se expone a authenticated: sólo columnas no-secretas.
REVOKE SELECT ON marketing_integraciones FROM authenticated;
GRANT SELECT (tenant_id, meta_pixel_id, meta_test_event_code, meta_activa, created_at, updated_at)
  ON marketing_integraciones TO authenticated;

-- ─── Upsert (dueño/admin del tenant) ───────────────────────────────────────
-- Si p_capi_token viene NULL/'', se conserva el token actual (permite editar el
-- Pixel ID sin re-tipear el token). Devuelve void.
CREATE OR REPLACE FUNCTION fn_upsert_marketing_meta(
  p_pixel_id TEXT,
  p_capi_token TEXT,
  p_test_event_code TEXT,
  p_activa BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_tenant UUID := auth_tenant_id();
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  INSERT INTO marketing_integraciones (tenant_id, meta_pixel_id, meta_capi_token, meta_test_event_code, meta_activa)
  VALUES (
    v_tenant,
    NULLIF(trim(p_pixel_id), ''),
    NULLIF(trim(p_capi_token), ''),
    NULLIF(trim(p_test_event_code), ''),
    COALESCE(p_activa, FALSE)
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    meta_pixel_id        = NULLIF(trim(p_pixel_id), ''),
    -- token: si vino vacío, conservar el existente.
    meta_capi_token      = COALESCE(NULLIF(trim(p_capi_token), ''), marketing_integraciones.meta_capi_token),
    meta_test_event_code = NULLIF(trim(p_test_event_code), ''),
    meta_activa          = COALESCE(p_activa, FALSE),
    updated_at           = NOW();
END;
$$;

-- ─── Pixel público para la web (mesa) ──────────────────────────────────────
-- Devuelve el Pixel ID del tenant dueño del local (por slug), sólo si la
-- integración está activa. No expone el token. Callable por anon (la web pública).
CREATE OR REPLACE FUNCTION fn_meta_pixel_publico(p_local_slug TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  -- El slug del perfil vive en comanda_local_settings (cls); el tenant en locales.
  SELECT mi.meta_pixel_id
  FROM comanda_local_settings cls
  JOIN locales l ON l.id = cls.local_id
  JOIN marketing_integraciones mi ON mi.tenant_id = l.tenant_id
  WHERE cls.slug = p_local_slug
    AND cls.deleted_at IS NULL
    AND mi.meta_activa = TRUE
    AND mi.meta_pixel_id IS NOT NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION fn_meta_pixel_publico(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_meta_pixel_publico(TEXT) TO anon, authenticated;

COMMENT ON TABLE marketing_integraciones IS
  'Config de integraciones de marketing por tenant (Meta Pixel + Conversions API). El token CAPI es secreto (solo service_role). Se edita desde Habitué → Integraciones.';

NOTIFY pgrst, 'reload schema';
