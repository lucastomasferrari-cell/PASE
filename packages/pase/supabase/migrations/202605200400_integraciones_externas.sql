-- ═══════════════════════════════════════════════════════════════════════════
-- Fase C — Foundations para integraciones con partners externos
-- (Rappi, PedidosYa, Deliverect, etc.)
--
-- 2 tablas:
--   - integraciones_externas_credenciales: 1 fila por (tenant_id, provider).
--     Guarda API key + secret + endpoint + config flexible en JSON. Solo
--     service_role lee — webhook validations los necesitan.
--   - mapeos_locales_externos: cuando Rappi/PeYa mandan un pedido,
--     vienen con SU id de local. Necesitamos saber a qué local_id de
--     COMANDA mapea.
--
-- Diseño:
--   - 1 tenant puede tener N providers activos (Rappi + PeYa + Deliverect).
--   - 1 (tenant, provider) puede tener N locales mapeados — un restaurant
--     con multi-sucursal tiene un external_local_id distinto por sede.
--   - Credentials cifrados at-rest por Supabase. Para mayor seguridad
--     migramos a pgsodium / vault en sprint futuro.
--
-- Por qué NO es 1 fila por local: Rappi/PeYa típicamente dan UN API key
-- por restaurant + N "stores" debajo. Mejor agrupar.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS integraciones_externas_credenciales (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'rappi' | 'pedidos-ya' | 'deliverect' | otros futuros
  provider TEXT NOT NULL CHECK (provider IN ('rappi', 'pedidos-ya', 'deliverect')),
  -- API credentials. Estructura libre — depende del provider.
  -- Ejemplos:
  --   Rappi:      { api_key, api_secret, webhook_secret, store_id_principal }
  --   PedidosYa:  { client_id, client_secret, restaurant_id }
  --   Deliverect: { api_key, account_id, channel_id }
  credentials JSONB NOT NULL DEFAULT '{}',
  -- Estado: configured = creds cargadas pero no probadas.
  --         active = ya probada con un ping/test exitoso.
  --         error = última prueba falló (ver last_error).
  estado TEXT NOT NULL DEFAULT 'configured' CHECK (estado IN ('configured', 'active', 'error')),
  last_test_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  notas TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER NULL REFERENCES usuarios(id),

  CONSTRAINT uniq_integracion_tenant_provider UNIQUE (tenant_id, provider)
);

CREATE TRIGGER trg_integraciones_set_updated_at
  BEFORE UPDATE ON integraciones_externas_credenciales
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE integraciones_externas_credenciales ENABLE ROW LEVEL SECURITY;

-- SELECT: solo dueño/admin del tenant (la columna credentials se filtra
-- via column-level GRANT abajo).
DROP POLICY IF EXISTS integraciones_select ON integraciones_externas_credenciales;
CREATE POLICY integraciones_select ON integraciones_externas_credenciales FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

DROP POLICY IF EXISTS integraciones_modify ON integraciones_externas_credenciales;
CREATE POLICY integraciones_modify ON integraciones_externas_credenciales FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

DROP POLICY IF EXISTS integraciones_service ON integraciones_externas_credenciales;
CREATE POLICY integraciones_service ON integraciones_externas_credenciales FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Column-level: el JSON credentials solo lo lee service_role.
-- El frontend ve estado + last_* pero no las API keys.
REVOKE SELECT ON integraciones_externas_credenciales FROM authenticated;
GRANT SELECT (
  id, tenant_id, provider, estado, last_test_at, last_error, notas,
  created_at, updated_at, created_by
) ON integraciones_externas_credenciales TO authenticated;

COMMENT ON TABLE integraciones_externas_credenciales IS
  'API keys + config para integraciones con Rappi/PedidosYa/Deliverect/etc. JSON credentials NO se expone a authenticated — solo service_role lo lee desde webhooks server-side.';


-- ─── Mapeos de locales externos → local_id COMANDA ─────────────────────────
CREATE TABLE IF NOT EXISTS mapeos_locales_externos (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('rappi', 'pedidos-ya', 'deliverect')),
  -- El ID que Rappi/PeYa usa para nuestra sucursal en su sistema.
  -- Ejemplo: Rappi store_id, PeYa restaurant_id.
  external_local_id TEXT NOT NULL,
  -- A qué local_id de COMANDA mapea.
  local_id INTEGER NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
  -- Si false, los pedidos de este local llegan pero quedan en estado
  -- "necesita_aprobacion" sin ser auto-creados (modo "vigilar" antes de
  -- pasar a live).
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_mapeo_provider_external UNIQUE (provider, external_local_id),
  CONSTRAINT uniq_mapeo_tenant_provider_local UNIQUE (tenant_id, provider, local_id)
);

CREATE TRIGGER trg_mapeos_set_updated_at
  BEFORE UPDATE ON mapeos_locales_externos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE mapeos_locales_externos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mapeos_select ON mapeos_locales_externos;
CREATE POLICY mapeos_select ON mapeos_locales_externos FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS mapeos_modify ON mapeos_locales_externos;
CREATE POLICY mapeos_modify ON mapeos_locales_externos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

DROP POLICY IF EXISTS mapeos_service ON mapeos_locales_externos;
CREATE POLICY mapeos_service ON mapeos_locales_externos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE mapeos_locales_externos IS
  'Mapeo entre el ID que Rappi/PeYa/Deliverect usa para nuestro local y nuestro local_id interno. El webhook handler usa este lookup para saber dónde encolar el pedido.';

CREATE INDEX IF NOT EXISTS idx_mapeos_provider_external
  ON mapeos_locales_externos(provider, external_local_id) WHERE activo = TRUE;


-- ─── RPC upsert credenciales (server-side validation) ──────────────────────
CREATE OR REPLACE FUNCTION fn_upsert_integracion(
  p_provider TEXT,
  p_credentials JSONB,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_id BIGINT;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'TENANT_NO_RESUELTO'; END IF;

  IF p_provider NOT IN ('rappi', 'pedidos-ya', 'deliverect') THEN
    RAISE EXCEPTION 'PROVIDER_INVALIDO';
  END IF;

  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() LIMIT 1;

  INSERT INTO integraciones_externas_credenciales (
    tenant_id, provider, credentials, notas, created_by
  ) VALUES (
    v_tenant_id, p_provider, p_credentials, p_notas, v_user_id
  )
  ON CONFLICT (tenant_id, provider) DO UPDATE SET
    credentials = EXCLUDED.credentials,
    notas = EXCLUDED.notas,
    -- al actualizar creds, volvemos a 'configured' para que el dueño
    -- haga ping/test antes de marcarlo active.
    estado = 'configured',
    last_error = NULL,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_upsert_integracion(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_upsert_integracion(TEXT, JSONB, TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION fn_eliminar_integracion(p_provider TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'PERMISO_DENEGADO'; END IF;
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'TENANT_NO_RESUELTO'; END IF;
  DELETE FROM integraciones_externas_credenciales
   WHERE tenant_id = v_tenant_id AND provider = p_provider;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_eliminar_integracion(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_eliminar_integracion(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
