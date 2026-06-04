-- 202606042500_rrhh_recibo_config.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Datos del negocio para los recibos de sueldo imprimibles (Lucas 04-jun).
-- PASE no guardaba razón social / CUIT / dirección — solo el nombre del local.
-- Esta tabla los guarda por local; el recibo los usa en el encabezado (si está
-- vacío, el front cae al nombre del local).
--
-- Tabla de CONFIG (no es ledger financiero) → escritura directa desde el
-- cliente con RLS está OK (no requiere RPC atómica).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rrhh_recibo_config (
  local_id      INTEGER PRIMARY KEY REFERENCES locales(id) ON DELETE CASCADE,
  razon_social  TEXT,
  cuit          TEXT,
  direccion     TEXT,
  tenant_id     UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE rrhh_recibo_config IS
  'Datos fiscales del negocio por local para el encabezado de los recibos de sueldo. Lucas 04-jun.';

ALTER TABLE rrhh_recibo_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rrhh_recibo_config_all ON rrhh_recibo_config;
CREATE POLICY rrhh_recibo_config_all ON rrhh_recibo_config
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

NOTIFY pgrst, 'reload schema';
