-- 202606160600_periodos_cerrados_schema.sql
-- Cierre de período: una fila por (tenant, local, mes) = ese mes está cerrado.
BEGIN;

CREATE TABLE IF NOT EXISTS periodos_cerrados (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  local_id     INTEGER NOT NULL,
  periodo_mes  DATE NOT NULL,                 -- primer día del mes cerrado
  cerrado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cerrado_por  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, periodo_mes)
);
CREATE INDEX IF NOT EXISTS idx_periodos_cerrados_local ON periodos_cerrados(local_id, periodo_mes);

ALTER TABLE periodos_cerrados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS periodos_cerrados_all ON periodos_cerrados;
CREATE POLICY periodos_cerrados_all ON periodos_cerrados FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

-- Helper que usan los triggers (SECURITY DEFINER → ve la tabla sin RLS).
CREATE OR REPLACE FUNCTION fn_periodo_esta_cerrado(p_local_id integer, p_fecha date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM periodos_cerrados
    WHERE local_id = p_local_id
      AND periodo_mes = date_trunc('month', p_fecha)::date
  );
$$;

COMMIT;
