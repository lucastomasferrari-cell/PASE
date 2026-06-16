-- 202606160100_utilidades_schema.sql
-- Módulo Utilidades: socios por local + %, repartos y su detalle por socio.
-- CAJA UTILIDADES NO es tabla nueva: es una cuenta en saldos_caja/movimientos
-- (el cashflow ya la reconoce). Se crea on-demand al primer reservar.
BEGIN;

CREATE TABLE IF NOT EXISTS utilidades_socios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  local_id    INTEGER NOT NULL,
  nombre      TEXT NOT NULL,
  porcentaje  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (porcentaje >= 0 AND porcentaje <= 100),
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_util_socios_tl ON utilidades_socios(tenant_id, local_id);

CREATE TABLE IF NOT EXISTS utilidades_repartos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  fecha         DATE NOT NULL,
  periodo_ref   DATE,                          -- mes de ganancia al que corresponde (opcional)
  total         NUMERIC(14,2) NOT NULL DEFAULT 0,
  cuenta_origen TEXT NOT NULL DEFAULT 'CAJA UTILIDADES',
  nota          TEXT,
  anulado       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_util_repartos_tl ON utilidades_repartos(tenant_id, local_id, fecha);

CREATE TABLE IF NOT EXISTS utilidades_reparto_detalle (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  reparto_id  UUID NOT NULL REFERENCES utilidades_repartos(id) ON DELETE CASCADE,
  socio_id    UUID NOT NULL REFERENCES utilidades_socios(id),
  monto       NUMERIC(14,2) NOT NULL DEFAULT 0,
  gasto_id    TEXT,                            -- el gasto retiro_socio generado (para reversar)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_util_detalle_reparto ON utilidades_reparto_detalle(reparto_id);

-- RLS dual con local_id
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['utilidades_socios','utilidades_repartos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_all ON %I', t, t);
    EXECUTE format($p$CREATE POLICY %I_all ON %I FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
      WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))$p$, t, t);
  END LOOP;
END $$;

-- detalle: RLS por tenant + vía el reparto padre (hija)
ALTER TABLE utilidades_reparto_detalle ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utilidades_reparto_detalle_all ON utilidades_reparto_detalle;
CREATE POLICY utilidades_reparto_detalle_all ON utilidades_reparto_detalle FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND EXISTS (
    SELECT 1 FROM utilidades_repartos r WHERE r.id = reparto_id
      AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (tenant_id = auth_tenant_id());

COMMIT;
