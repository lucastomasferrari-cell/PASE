-- ─── Conciliación bancaria file-based ────────────────────────────────────────
-- Estructura inicial para subir extractos bancarios (CSV/Excel) y matchearlos
-- contra movimientos del sistema (pagos a proveedores, depósitos, etc.).
--
-- Flujo:
--   1. Dueño exporta el extracto del homebanking (formato del banco).
--   2. Sube el archivo en /pagos/conciliacion-bancaria.
--   3. El parser lo convierte en líneas → bank_statement_lines.
--   4. Cada línea intenta auto-match contra movimientos (monto+fecha±N días).
--   5. UI muestra matched/unmatched, permite confirmar/rechazar manualmente.
--
-- Multi-tenant + RLS. SECURITY DEFINER no necesario porque toda mutación
-- viene del cliente autenticado.

CREATE TABLE IF NOT EXISTS bank_statements (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id      INTEGER NULL REFERENCES locales(id),
  cuenta_id     INTEGER NULL REFERENCES cuentas(id),

  filename      TEXT NOT NULL,
  banco         TEXT NULL,  -- 'galicia' | 'santander' | etc (opcional)
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   INTEGER NULL REFERENCES usuarios(id),

  periodo_desde DATE NULL,
  periodo_hasta DATE NULL,
  total_lineas  INTEGER NOT NULL DEFAULT 0,
  total_matched INTEGER NOT NULL DEFAULT 0,

  estado        TEXT NOT NULL DEFAULT 'procesando',  -- procesando | listo | archivado
  notas         TEXT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_bank_statements_tenant
  ON bank_statements(tenant_id, uploaded_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE bank_statements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statements_tenant ON bank_statements;
CREATE POLICY bank_statements_tenant ON bank_statements FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

DROP TRIGGER IF EXISTS trg_bank_statements_set_updated_at ON bank_statements;
CREATE TRIGGER trg_bank_statements_set_updated_at
  BEFORE UPDATE ON bank_statements FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── Líneas del extracto ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_id  INTEGER NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,

  fecha         DATE NOT NULL,
  descripcion   TEXT NOT NULL,
  monto         NUMERIC(14,2) NOT NULL,  -- positivo = ingreso, negativo = egreso
  saldo         NUMERIC(14,2) NULL,
  referencia    TEXT NULL,  -- nro operación banco

  -- Matching
  matched_movimiento_id INTEGER NULL REFERENCES movimientos(id),
  matched_at    TIMESTAMPTZ NULL,
  matched_por   INTEGER NULL REFERENCES usuarios(id),
  match_score   NUMERIC(3,2) NULL,  -- 0.00-1.00 confianza del match auto

  notas         TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_statement
  ON bank_statement_lines(statement_id);
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_unmatched
  ON bank_statement_lines(tenant_id, fecha) WHERE matched_movimiento_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_match
  ON bank_statement_lines(matched_movimiento_id) WHERE matched_movimiento_id IS NOT NULL;

ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statement_lines_tenant ON bank_statement_lines;
CREATE POLICY bank_statement_lines_tenant ON bank_statement_lines FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

DROP TRIGGER IF EXISTS trg_bank_statement_lines_set_updated_at ON bank_statement_lines;
CREATE TRIGGER trg_bank_statement_lines_set_updated_at
  BEFORE UPDATE ON bank_statement_lines FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Helper: contar matched/total del statement (para mostrar en UI)
CREATE OR REPLACE FUNCTION fn_bank_statement_refresh_counters(p_statement_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_total INTEGER;
  v_matched INTEGER;
BEGIN
  -- Auth check: el statement debe ser del tenant del caller
  SELECT tenant_id INTO v_tenant_id FROM bank_statements WHERE id = p_statement_id;
  IF v_tenant_id IS NULL OR v_tenant_id != auth_tenant_id() THEN
    RAISE EXCEPTION 'STATEMENT_NO_AUTORIZADO';
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE matched_movimiento_id IS NOT NULL)
    INTO v_total, v_matched
    FROM bank_statement_lines
   WHERE statement_id = p_statement_id;

  UPDATE bank_statements
     SET total_lineas = v_total,
         total_matched = v_matched,
         estado = CASE WHEN v_matched = v_total AND v_total > 0 THEN 'listo' ELSE 'procesando' END
   WHERE id = p_statement_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_bank_statement_refresh_counters(INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
