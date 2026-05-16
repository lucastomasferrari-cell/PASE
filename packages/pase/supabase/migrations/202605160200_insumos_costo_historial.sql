-- ─── Historial de costo de insumos + alertas de variación ──────────────────
-- Cada vez que insumos.costo_actual cambia, guardamos snapshot en
-- insumos_costo_history. Sirve para:
--   - Gráfico de tendencia de costo del insumo (últimos N días)
--   - Alertas "subió X% en última semana" para que el dueño actualice precios
--   - Auditoría de quién/cuándo cambió el costo
--
-- El trigger se dispara solo cuando costo_actual cambia (no en cada UPDATE).
-- El primer registro de cada insumo se crea cuando aparece costo no-NULL
-- por primera vez (no para insumos creados con costo NULL desde el inicio).

CREATE TABLE IF NOT EXISTS insumos_costo_history (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  insumo_id     INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  costo_anterior NUMERIC(14,4) NULL,
  costo_nuevo    NUMERIC(14,4) NOT NULL,
  variacion_pct  NUMERIC(8,2) NULL,  -- (nuevo - anterior) / anterior * 100
  fuente         TEXT NULL,  -- 'trigger_mp' | 'manual' | 'import' (informativo)
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by    INTEGER NULL REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_icost_hist_insumo
  ON insumos_costo_history(insumo_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_icost_hist_tenant
  ON insumos_costo_history(tenant_id, changed_at DESC);

ALTER TABLE insumos_costo_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS insumos_costo_history_tenant ON insumos_costo_history;
CREATE POLICY insumos_costo_history_tenant ON insumos_costo_history FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

-- Trigger: snapshot al cambio de costo_actual
CREATE OR REPLACE FUNCTION fn_insumos_costo_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_variacion NUMERIC;
BEGIN
  -- Solo registrar si costo_actual REALMENTE cambió
  IF NEW.costo_actual IS NULL THEN RETURN NEW; END IF;
  IF OLD.costo_actual IS NOT DISTINCT FROM NEW.costo_actual THEN RETURN NEW; END IF;

  -- Calcular variación %
  IF OLD.costo_actual IS NOT NULL AND OLD.costo_actual > 0 THEN
    v_variacion := ((NEW.costo_actual - OLD.costo_actual) / OLD.costo_actual) * 100;
  ELSE
    v_variacion := NULL;  -- primera vez con costo
  END IF;

  INSERT INTO insumos_costo_history (
    tenant_id, insumo_id, costo_anterior, costo_nuevo, variacion_pct, fuente
  ) VALUES (
    NEW.tenant_id, NEW.id, OLD.costo_actual, NEW.costo_actual, v_variacion,
    'trigger_auto'  -- TODO: distinguir trigger_mp vs manual (necesita context que hoy no tenemos)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_insumos_costo_snapshot ON insumos;
CREATE TRIGGER trg_insumos_costo_snapshot
  AFTER UPDATE OF costo_actual ON insumos
  FOR EACH ROW
  EXECUTE FUNCTION fn_insumos_costo_snapshot();

-- ─── RPC: lista insumos con alertas de variación >= threshold ────────────────
-- Devuelve cada insumo con su variación de la última semana (vs costo previo).
-- Si variación >= threshold% → flag alerta. Usado en dashboard CMV.
CREATE OR REPLACE FUNCTION fn_insumos_con_alertas_costo(
  p_dias INTEGER DEFAULT 7,
  p_umbral_pct NUMERIC DEFAULT 15
)
RETURNS TABLE (
  insumo_id INTEGER,
  insumo_nombre TEXT,
  insumo_emoji TEXT,
  costo_actual NUMERIC,
  costo_anterior NUMERIC,
  variacion_pct NUMERIC,
  ultima_variacion_at TIMESTAMPTZ,
  alerta BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ultima_variacion AS (
    SELECT DISTINCT ON (insumo_id)
      insumo_id,
      costo_anterior,
      variacion_pct,
      changed_at
    FROM insumos_costo_history
    WHERE tenant_id = auth_tenant_id()
      AND changed_at >= NOW() - (p_dias || ' days')::INTERVAL
    ORDER BY insumo_id, changed_at DESC
  )
  SELECT
    i.id,
    i.nombre,
    i.emoji,
    i.costo_actual,
    uv.costo_anterior,
    uv.variacion_pct,
    uv.changed_at,
    (uv.variacion_pct IS NOT NULL AND ABS(uv.variacion_pct) >= p_umbral_pct) AS alerta
  FROM insumos i
  LEFT JOIN ultima_variacion uv ON uv.insumo_id = i.id
  WHERE i.tenant_id = auth_tenant_id()
    AND i.deleted_at IS NULL
    AND uv.insumo_id IS NOT NULL  -- solo insumos con cambios en el período
  ORDER BY ABS(COALESCE(uv.variacion_pct, 0)) DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION fn_insumos_con_alertas_costo(INTEGER, NUMERIC) TO authenticated;

-- ─── RPC: historial de un insumo específico (para chart) ─────────────────────
CREATE OR REPLACE FUNCTION fn_insumo_costo_chart(
  p_insumo_id INTEGER,
  p_dias INTEGER DEFAULT 90
)
RETURNS TABLE (
  changed_at TIMESTAMPTZ,
  costo NUMERIC,
  variacion_pct NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    changed_at,
    costo_nuevo,
    variacion_pct
  FROM insumos_costo_history
  WHERE tenant_id = auth_tenant_id()
    AND insumo_id = p_insumo_id
    AND changed_at >= NOW() - (p_dias || ' days')::INTERVAL
  ORDER BY changed_at ASC;
$$;

GRANT EXECUTE ON FUNCTION fn_insumo_costo_chart(INTEGER, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
