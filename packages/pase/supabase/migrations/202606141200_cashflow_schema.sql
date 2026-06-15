-- 202606141200_cashflow_schema.sql
-- Módulo Cashflow: extractos cargados (MP/banco), líneas clasificadas,
-- memoria de clasificación, y cierre/bloqueo de mes. El efectivo NO se guarda
-- acá (se lee de movimientos en tiempo de cálculo).
BEGIN;

-- 1) Extractos subidos (un registro por archivo MP/banco de un mes)
CREATE TABLE IF NOT EXISTS cashflow_extractos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  cuenta        TEXT NOT NULL CHECK (cuenta IN ('MercadoPago','Banco')),
  periodo_mes   DATE NOT NULL,                  -- primer día del mes (ej 2026-05-01)
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  saldo_final   NUMERIC(14,2) NOT NULL DEFAULT 0,
  archivo_nombre TEXT,
  estado        TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','confirmado')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, cuenta, periodo_mes)
);
CREATE INDEX IF NOT EXISTS idx_cf_extractos_tl ON cashflow_extractos(tenant_id, local_id, periodo_mes);

-- 2) Líneas de cada extracto, clasificadas
CREATE TABLE IF NOT EXISTS cashflow_lineas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  local_id     INTEGER NOT NULL,
  extracto_id  UUID NOT NULL REFERENCES cashflow_extractos(id) ON DELETE CASCADE,
  fecha        DATE NOT NULL,
  descripcion  TEXT NOT NULL DEFAULT '',
  monto_bruto  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- entró/salió segun extracto (con signo)
  comision     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- comisión separada (si aplica)
  retencion    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- impuesto/retención separado
  categoria    TEXT,                                -- venta/comision/retencion/proveedor/sueldo/gasto/retiro_socio/aporte_socio/obra_capex/transferencia_interna/otro
  es_interno   BOOLEAN NOT NULL DEFAULT FALSE,      -- transferencia entre cuentas propias (netea)
  confirmada   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cf_lineas_ext ON cashflow_lineas(extracto_id);
CREATE INDEX IF NOT EXISTS idx_cf_lineas_tl ON cashflow_lineas(tenant_id, local_id, fecha);

-- 3) Memoria de clasificación (texto normalizado → categoría)
CREATE TABLE IF NOT EXISTS cashflow_mapeo (
  tenant_id   UUID NOT NULL,
  texto_norm  TEXT NOT NULL,
  cuenta      TEXT NOT NULL DEFAULT '*',           -- '*' = cualquier cuenta, o 'MercadoPago'/'Banco'
  categoria   TEXT NOT NULL,
  es_interno  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, texto_norm, cuenta)
);

-- 4) Cierre/bloqueo de mes
CREATE TABLE IF NOT EXISTS cashflow_cierres (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  periodo_mes   DATE NOT NULL,
  saldos        JSONB NOT NULL DEFAULT '{}',          -- {efectivo, mercadopago, banco, transito}
  bloqueado     BOOLEAN NOT NULL DEFAULT FALSE,
  bloqueado_at  TIMESTAMPTZ,
  bloqueado_por INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, periodo_mes)
);

-- RLS dual en las 3 tablas con local_id
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cashflow_extractos','cashflow_lineas','cashflow_cierres'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_all ON %I', t, t);
    EXECUTE format($p$CREATE POLICY %I_all ON %I FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
      WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))$p$, t, t);
  END LOOP;
END $$;

-- cashflow_mapeo no tiene local_id → RLS solo por tenant
ALTER TABLE cashflow_mapeo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cashflow_mapeo_all ON cashflow_mapeo;
CREATE POLICY cashflow_mapeo_all ON cashflow_mapeo FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());

COMMIT;
