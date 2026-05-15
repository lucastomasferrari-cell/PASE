-- ═══════════════════════════════════════════════════════════════════════════
-- CMV refactor — materia prima ↔ insumo unificado
-- ═══════════════════════════════════════════════════════════════════════════
-- Antes: una sola tabla `insumos` que mezclaba el ingrediente unificado
-- ("Trucha") con la materia prima específica del proveedor ("Trucha c/vísceras
-- Pescadería X"). Para 2 proveedores del mismo ingrediente había que duplicar
-- el insumo + sumar a la receta dos líneas distintas — feo y mal.
--
-- Ahora:
--   insumos        = el unificado (lo que la cocina usa, lo que va en receta).
--                    costo_actual = promedio simple del costo_efectivo de las
--                    materias_primas activas vinculadas.
--   materias_primas = la versión específica del proveedor con su packaging,
--                    factor de conversión, merma y precio último.
--                    Vincula factura_items → insumo unificado.
--
-- Fórmula costo_efectivo de una MP:
--   precio_actual / (factor_conversion * (1 - merma_pct/100))
--
-- Ej: 1kg Trucha c/vísceras $10.000, factor=1, merma=35% →
--     costo_efectivo = 10.000 / (1 * 0.65) = $15.385/kg de insumo "Trucha"

-- ─── 1. Tabla materias_primas ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS materias_primas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ NULL,
  created_by      INTEGER NULL REFERENCES usuarios(id),
  updated_by      INTEGER NULL REFERENCES usuarios(id),

  -- Identificación
  nombre          TEXT NOT NULL,
  proveedor_id    INTEGER NULL REFERENCES proveedores(id),
  insumo_id       BIGINT NOT NULL REFERENCES insumos(id),

  -- Compra
  unidad_compra   TEXT NOT NULL,  -- kg, g, L, ml, un, etc.
  factor_conversion NUMERIC(10,4) NOT NULL DEFAULT 1,  -- 1 unidad compra = X unidades insumo (antes de merma)
  merma_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,    -- 0-100. % desperdicio procesando

  -- Costos (precio_actual = último precio cargado en factura)
  precio_actual   NUMERIC(12,2) NULL,
  precio_actualizado_at TIMESTAMPTZ NULL,

  -- Meta
  notas           TEXT NULL,
  activa          BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT chk_mp_nombre_no_vacio CHECK (length(trim(nombre)) > 0),
  CONSTRAINT chk_mp_factor_positivo CHECK (factor_conversion > 0),
  CONSTRAINT chk_mp_merma_pct CHECK (merma_pct >= 0 AND merma_pct < 100),
  CONSTRAINT chk_mp_unidad CHECK (unidad_compra IN ('kg','g','L','ml','un','porcion','docena','caja','bolsa'))
);

CREATE INDEX IF NOT EXISTS idx_mp_tenant ON materias_primas(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mp_insumo ON materias_primas(insumo_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mp_proveedor ON materias_primas(proveedor_id) WHERE deleted_at IS NULL;

-- UNIQUE parcial: nombre único por tenant + proveedor (un proveedor no vende
-- el mismo nombre dos veces). NULL en proveedor_id = MP genérica/manual.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mp_nombre_proveedor
  ON materias_primas(tenant_id, COALESCE(proveedor_id, 0), lower(nombre))
  WHERE deleted_at IS NULL;

-- updated_at trigger
CREATE TRIGGER trg_mp_set_updated_at BEFORE UPDATE ON materias_primas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE materias_primas IS
  'CMV refactor 2026-05-15: catálogo de materias primas (lo que se compra del proveedor con su packaging/merma). Vincula factura_items con insumos unificados.';

-- ─── 2. RLS dual ─────────────────────────────────────────────────────────
ALTER TABLE materias_primas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS materias_primas_select ON materias_primas;
CREATE POLICY materias_primas_select ON materias_primas FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS materias_primas_modify ON materias_primas;
CREATE POLICY materias_primas_modify ON materias_primas FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  );

DROP POLICY IF EXISTS materias_primas_service ON materias_primas;
CREATE POLICY materias_primas_service ON materias_primas FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── 3. Vínculo factura_items → materia_prima ───────────────────────────
ALTER TABLE factura_items
  ADD COLUMN IF NOT EXISTS materia_prima_id BIGINT NULL REFERENCES materias_primas(id);

CREATE INDEX IF NOT EXISTS idx_fi_materia_prima
  ON factura_items(materia_prima_id) WHERE materia_prima_id IS NOT NULL;

COMMENT ON COLUMN factura_items.materia_prima_id IS
  'CMV refactor: vincula este item de factura con una materia prima del catálogo. Al cargar, dispara trigger que actualiza el costo del insumo unificado.';

-- ─── 4. Función: recalcular costo del insumo unificado ──────────────────
-- Promedio simple del costo_efectivo de las materias_primas activas vinculadas.
-- costo_efectivo = precio_actual / (factor_conversion * (1 - merma_pct/100))
CREATE OR REPLACE FUNCTION fn_recalc_costo_insumo(p_insumo_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_costo_promedio NUMERIC;
BEGIN
  SELECT AVG(
    precio_actual / NULLIF(factor_conversion * (1 - merma_pct / 100.0), 0)
  )
  INTO v_costo_promedio
  FROM materias_primas
  WHERE insumo_id = p_insumo_id
    AND activa = TRUE
    AND deleted_at IS NULL
    AND precio_actual IS NOT NULL
    AND precio_actual > 0;

  IF v_costo_promedio IS NOT NULL THEN
    UPDATE insumos
      SET costo_actual = ROUND(v_costo_promedio::numeric, 2),
          costo_actualizado_at = NOW(),
          updated_at = NOW()
      WHERE id = p_insumo_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_recalc_costo_insumo IS
  'Recalcula insumos.costo_actual como promedio simple del costo_efectivo de las materias_primas activas vinculadas. costo_efectivo = precio_actual / (factor_conversion * (1 - merma_pct/100)).';

-- ─── 5. Trigger: recalcular al cambiar materia_prima ─────────────────────
CREATE OR REPLACE FUNCTION fn_trg_mp_recalc_insumo()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- INSERT o UPDATE de campos que afectan costo → recalcular
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_recalc_costo_insumo(NEW.insumo_id);
  ELSIF TG_OP = 'UPDATE' AND (
    OLD.precio_actual IS DISTINCT FROM NEW.precio_actual OR
    OLD.factor_conversion IS DISTINCT FROM NEW.factor_conversion OR
    OLD.merma_pct IS DISTINCT FROM NEW.merma_pct OR
    OLD.activa IS DISTINCT FROM NEW.activa OR
    OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR
    OLD.insumo_id IS DISTINCT FROM NEW.insumo_id
  ) THEN
    PERFORM fn_recalc_costo_insumo(NEW.insumo_id);
    -- Si cambió el insumo_id, recalcular también el viejo.
    IF OLD.insumo_id IS DISTINCT FROM NEW.insumo_id THEN
      PERFORM fn_recalc_costo_insumo(OLD.insumo_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mp_recalc_insumo ON materias_primas;
CREATE TRIGGER trg_mp_recalc_insumo
  AFTER INSERT OR UPDATE ON materias_primas
  FOR EACH ROW EXECUTE FUNCTION fn_trg_mp_recalc_insumo();

-- ─── 6. Trigger: actualizar precio_actual MP al cargar factura_item ─────
-- Cuando se inserta un factura_item con materia_prima_id, asume que ese precio
-- es el "más reciente" y actualiza precio_actual de la MP → dispara recalc
-- en cascada via el trigger anterior.
CREATE OR REPLACE FUNCTION fn_trg_factura_item_actualizar_mp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_precio_unitario_real NUMERIC;
BEGIN
  IF NEW.materia_prima_id IS NULL THEN RETURN NEW; END IF;

  v_precio_unitario_real := NEW.precio_unitario;
  IF v_precio_unitario_real IS NULL OR v_precio_unitario_real <= 0 THEN
    RETURN NEW;
  END IF;

  UPDATE materias_primas SET
    precio_actual = v_precio_unitario_real,
    precio_actualizado_at = NOW(),
    updated_at = NOW()
  WHERE id = NEW.materia_prima_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_factura_item_actualiza_mp ON factura_items;
CREATE TRIGGER trg_factura_item_actualiza_mp
  AFTER INSERT OR UPDATE ON factura_items
  FOR EACH ROW EXECUTE FUNCTION fn_trg_factura_item_actualizar_mp();

-- ─── 7. v_orden_delete y v_orden_insert (restore_tenant) ────────────────
-- Las tablas backup/restore deben conocer la nueva tabla. Lo agrego en
-- la próxima migration que toque restore_tenant (deuda corta F1.2b style).
-- TODO: agregar 'materias_primas' a los arrays antes de un drop tenant real.

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN refactor CMV
-- ═══════════════════════════════════════════════════════════════════════════
