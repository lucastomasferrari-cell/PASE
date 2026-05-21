-- ═══════════════════════════════════════════════════════════════════════════
-- Simulaciones de sensibilidad — what-if sobre datos históricos
--
-- Caso de uso (Lucas): "¿qué pasaría si subo el plato de salmón 15%? ¿Y si
-- el salmón sube 30%? ¿Y si encima vendo 20% menos por la suba?"
--
-- La simulación NO modifica datos reales. Toma un período histórico, aplica
-- cambios hipotéticos (precios, costos, mix, elasticidad), y calcula cómo
-- habría sido la facturación, los costos y el margen.
--
-- Importante: usa los snapshots inmutables de recetas (recetas_versiones)
-- vigentes en cada fecha del período, no las recetas actuales. Eso hace
-- la simulación "histórica honesta" — no aplica recetas de hoy a ventas
-- de hace 3 meses.
--
-- Tipos de cambio soportados (en JSONB `cambios`):
--   { tipo: "precio_venta",            item_ids: [...] | scope: "todos", factor: 1.15 }
--   { tipo: "costo_insumo",            insumo_ids: [...] | scope: "todos", factor: 0.9 }
--   { tipo: "mix_volumen",             item_ids: [...], factor: 1.20 }
--   { tipo: "inflacion_global",        factor: 1.15 }  // sube todos los costos
--
-- Elasticidad (JSONB `elasticidad`):
--   { ratio_global: -0.5 }  // por cada +1% de precio, -0.5% de volumen
--   null o {} → sin elasticidad (asume volumen constante)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS simulaciones (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  -- Período histórico de base
  local_id        INTEGER,  -- NULL = todos los locales del tenant
  periodo_desde   DATE NOT NULL,
  periodo_hasta   DATE NOT NULL,
  -- Configuración
  cambios         JSONB NOT NULL DEFAULT '[]'::jsonb,
  elasticidad    JSONB DEFAULT '{}'::jsonb,
  -- Resultado cacheado (se recalcula con fn_simular_escenario)
  resultado       JSONB,
  calculado_at    TIMESTAMPTZ,
  -- Audit
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  created_by      INTEGER,
  -- Constraints
  CONSTRAINT periodo_valido CHECK (periodo_desde <= periodo_hasta)
);

CREATE INDEX IF NOT EXISTS idx_simulaciones_tenant
  ON simulaciones(tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_simulaciones_local
  ON simulaciones(tenant_id, local_id, created_at DESC)
  WHERE deleted_at IS NULL AND local_id IS NOT NULL;

-- RLS: tenant-scoped, requiere permiso de gestión (dueño/admin)
ALTER TABLE simulaciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY simulaciones_all ON simulaciones FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND auth_es_dueno_o_admin()
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND auth_es_dueno_o_admin()
  );

-- Updated_at
CREATE OR REPLACE FUNCTION trg_simulaciones_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS simulaciones_updated_at ON simulaciones;
CREATE TRIGGER simulaciones_updated_at BEFORE UPDATE ON simulaciones
  FOR EACH ROW EXECUTE FUNCTION trg_simulaciones_updated_at();

-- ─── Helper interno: extraer factor de un cambio JSONB ────────────────────
-- Dado un array de cambios, un tipo, y un id (de item o insumo), devuelve
-- el factor que aplica. Soporta `scope: "todos"` y arrays `item_ids/insumo_ids`.
-- Si ningún cambio matchea, devuelve `default_factor`.
-- Declarado ARRIBA de fn_simular_escenario para que la referencia funcione
-- en tiempo de creación.
CREATE OR REPLACE FUNCTION fn_simulaciones_get_factor(
  p_cambios JSONB,
  p_tipo TEXT,
  p_id TEXT,
  p_default NUMERIC DEFAULT 1.0
)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_cambio JSONB;
  v_factor NUMERIC := p_default;
BEGIN
  FOR v_cambio IN
    SELECT c FROM jsonb_array_elements(p_cambios) c
    WHERE c->>'tipo' = p_tipo
  LOOP
    IF v_cambio->>'scope' = 'todos' THEN
      v_factor := COALESCE((v_cambio->>'factor')::NUMERIC, p_default);
      CONTINUE;
    END IF;
    IF (v_cambio ? 'item_ids' AND v_cambio->'item_ids' @> to_jsonb(p_id))
       OR (v_cambio ? 'insumo_ids' AND v_cambio->'insumo_ids' @> to_jsonb(p_id))
       OR (v_cambio ? 'item_ids' AND v_cambio->'item_ids' @> to_jsonb(p_id::NUMERIC))
       OR (v_cambio ? 'insumo_ids' AND v_cambio->'insumo_ids' @> to_jsonb(p_id::NUMERIC))
    THEN
      v_factor := COALESCE((v_cambio->>'factor')::NUMERIC, p_default);
    END IF;
  END LOOP;
  RETURN v_factor;
END;
$$;

-- ─── Motor de simulación ───────────────────────────────────────────────────
-- Calcula el escenario y guarda el resultado en simulaciones.resultado.
-- Se puede invocar manualmente o auto-disparar cuando cambian los inputs.
--
-- Algoritmo:
--   1. Cargar ventas reales del período (ventas_pos + ventas_pos_items).
--   2. Para cada item vendido:
--      - precio_efectivo = precio_real × factor_precio[item]
--      - factor_elasticidad = 1 + (factor_precio - 1) × ratio_elasticidad
--      - factor_mix_manual = factor_mix[item] | 1.0
--      - cantidad_efectiva = cantidad_real × factor_elasticidad × factor_mix
--      - Calcular costo recetando con costos hipotéticos
--      - Sumar al total
--   3. Comparar contra el real y guardar el delta.

CREATE OR REPLACE FUNCTION fn_simular_escenario(p_simulacion_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sim RECORD;
  v_real_facturacion NUMERIC := 0;
  v_real_costo NUMERIC := 0;
  v_real_items_vendidos NUMERIC := 0;
  v_hip_facturacion NUMERIC := 0;
  v_hip_costo NUMERIC := 0;
  v_hip_items_vendidos NUMERIC := 0;
  v_resultado JSONB;
  v_elast_ratio NUMERIC;
  v_item RECORD;
  v_factor_precio NUMERIC;
  v_factor_mix NUMERIC;
  v_factor_costo NUMERIC;
  v_factor_elast NUMERIC;
  v_cant_real NUMERIC;
  v_cant_hip NUMERIC;
  v_precio_real NUMERIC;
  v_precio_hip NUMERIC;
  v_costo_real_unit NUMERIC;
  v_costo_hip_unit NUMERIC;
  v_inflacion_global NUMERIC := 1;
BEGIN
  -- Validar permisos + cargar simulación
  SELECT * INTO v_sim FROM simulaciones
    WHERE id = p_simulacion_id
      AND tenant_id = auth_tenant_id()
      AND deleted_at IS NULL;
  IF v_sim IS NULL THEN RAISE EXCEPTION 'SIMULACION_NO_ENCONTRADA'; END IF;

  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'SOLO_DUENO_O_ADMIN';
  END IF;

  -- Ratio de elasticidad global (default 0 = sin elasticidad)
  v_elast_ratio := COALESCE((v_sim.elasticidad->>'ratio_global')::NUMERIC, 0);

  -- Factor de inflación global (si hay un cambio tipo inflacion_global,
  -- multiplica TODOS los costos)
  SELECT COALESCE((c->>'factor')::NUMERIC, 1) INTO v_inflacion_global
    FROM jsonb_array_elements(v_sim.cambios) c
    WHERE c->>'tipo' = 'inflacion_global'
    LIMIT 1;
  v_inflacion_global := COALESCE(v_inflacion_global, 1);

  -- Iterar sobre cada ítem vendido en el período
  FOR v_item IN
    SELECT
      vpi.item_id,
      vpi.cantidad,
      vpi.precio_unitario,
      vpi.subtotal,
      -- Snapshot de receta vigente al momento de la venta (cobrada)
      -- Si no hay snapshot (item sin receta), costo = 0 y solo cuenta como ingreso.
      (SELECT rv.receta_data
         FROM recetas_versiones rv
        WHERE rv.item_id = vpi.item_id
          AND rv.tenant_id = vp.tenant_id
        ORDER BY rv.created_at DESC
        LIMIT 1) AS receta_snapshot,
      vp.local_id AS venta_local_id
    FROM ventas_pos vp
    INNER JOIN ventas_pos_items vpi ON vpi.venta_id = vp.id
    WHERE vp.tenant_id = v_sim.tenant_id
      AND (v_sim.local_id IS NULL OR vp.local_id = v_sim.local_id)
      AND vp.fecha::DATE BETWEEN v_sim.periodo_desde AND v_sim.periodo_hasta
      AND vp.estado = 'cobrada'
      AND vp.deleted_at IS NULL
      AND vpi.deleted_at IS NULL
      AND vpi.estado != 'anulado'
  LOOP
    -- ─── REAL ───
    v_cant_real := COALESCE(v_item.cantidad, 0);
    v_precio_real := COALESCE(v_item.precio_unitario, 0);
    v_real_facturacion := v_real_facturacion + v_cant_real * v_precio_real;
    v_real_items_vendidos := v_real_items_vendidos + v_cant_real;

    -- Costo real desde snapshot de receta
    v_costo_real_unit := 0;
    IF v_item.receta_snapshot IS NOT NULL THEN
      v_costo_real_unit := COALESCE(
        (SELECT SUM((ri->>'cantidad')::NUMERIC * (ri->>'costo_actual')::NUMERIC)
           FROM jsonb_array_elements(v_item.receta_snapshot->'insumos') ri),
        0
      );
      -- Dividir por rendimiento si es > 1
      v_costo_real_unit := v_costo_real_unit / GREATEST(COALESCE((v_item.receta_snapshot->>'rendimiento')::NUMERIC, 1), 1);
    END IF;
    v_real_costo := v_real_costo + v_cant_real * v_costo_real_unit;

    -- ─── HIPOTÉTICO ───
    -- 1. Factor de precio para este item
    v_factor_precio := fn_simulaciones_get_factor(
      v_sim.cambios, 'precio_venta', v_item.item_id::TEXT, 1.0
    );
    -- 2. Factor de mix volumen
    v_factor_mix := fn_simulaciones_get_factor(
      v_sim.cambios, 'mix_volumen', v_item.item_id::TEXT, 1.0
    );
    -- 3. Factor elasticidad (depende del cambio de precio)
    v_factor_elast := 1 + (v_factor_precio - 1) * v_elast_ratio;

    -- Cantidad hipotética
    v_cant_hip := v_cant_real * v_factor_elast * v_factor_mix;
    v_precio_hip := v_precio_real * v_factor_precio;

    v_hip_facturacion := v_hip_facturacion + v_cant_hip * v_precio_hip;
    v_hip_items_vendidos := v_hip_items_vendidos + v_cant_hip;

    -- Costo hipotético: recalcular con cambios de costo aplicados a cada insumo
    -- y aplicar inflacion_global si corresponde
    v_costo_hip_unit := 0;
    IF v_item.receta_snapshot IS NOT NULL THEN
      v_costo_hip_unit := COALESCE(
        (SELECT SUM(
            (ri->>'cantidad')::NUMERIC * (ri->>'costo_actual')::NUMERIC
            * fn_simulaciones_get_factor(v_sim.cambios, 'costo_insumo', ri->>'insumo_id', 1.0)
            * v_inflacion_global
          )
          FROM jsonb_array_elements(v_item.receta_snapshot->'insumos') ri),
        0
      );
      v_costo_hip_unit := v_costo_hip_unit / GREATEST(COALESCE((v_item.receta_snapshot->>'rendimiento')::NUMERIC, 1), 1);
    END IF;
    v_hip_costo := v_hip_costo + v_cant_hip * v_costo_hip_unit;
  END LOOP;

  -- Armar JSON resultado
  v_resultado := jsonb_build_object(
    'real', jsonb_build_object(
      'facturacion', ROUND(v_real_facturacion, 2),
      'costo', ROUND(v_real_costo, 2),
      'margen', ROUND(v_real_facturacion - v_real_costo, 2),
      'margen_pct', CASE
        WHEN v_real_facturacion > 0
        THEN ROUND((v_real_facturacion - v_real_costo) / v_real_facturacion * 100, 2)
        ELSE 0
      END,
      'items_vendidos', ROUND(v_real_items_vendidos, 2)
    ),
    'hipotetico', jsonb_build_object(
      'facturacion', ROUND(v_hip_facturacion, 2),
      'costo', ROUND(v_hip_costo, 2),
      'margen', ROUND(v_hip_facturacion - v_hip_costo, 2),
      'margen_pct', CASE
        WHEN v_hip_facturacion > 0
        THEN ROUND((v_hip_facturacion - v_hip_costo) / v_hip_facturacion * 100, 2)
        ELSE 0
      END,
      'items_vendidos', ROUND(v_hip_items_vendidos, 2)
    ),
    'delta', jsonb_build_object(
      'facturacion', ROUND(v_hip_facturacion - v_real_facturacion, 2),
      'facturacion_pct', CASE
        WHEN v_real_facturacion > 0
        THEN ROUND((v_hip_facturacion - v_real_facturacion) / v_real_facturacion * 100, 2)
        ELSE 0
      END,
      'margen', ROUND((v_hip_facturacion - v_hip_costo) - (v_real_facturacion - v_real_costo), 2),
      'margen_pct_pp', CASE
        WHEN v_real_facturacion > 0 AND v_hip_facturacion > 0
        THEN ROUND(
          (v_hip_facturacion - v_hip_costo) / v_hip_facturacion * 100
          - (v_real_facturacion - v_real_costo) / v_real_facturacion * 100,
          2
        )
        ELSE 0
      END,
      'items_vendidos_pct', CASE
        WHEN v_real_items_vendidos > 0
        THEN ROUND((v_hip_items_vendidos - v_real_items_vendidos) / v_real_items_vendidos * 100, 2)
        ELSE 0
      END
    ),
    'elasticidad_aplicada', v_elast_ratio,
    'inflacion_aplicada', v_inflacion_global,
    'calculado_at', NOW()::TEXT
  );

  -- Guardar en la tabla
  UPDATE simulaciones SET
    resultado = v_resultado,
    calculado_at = NOW(),
    updated_at = NOW()
  WHERE id = p_simulacion_id;

  RETURN v_resultado;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_simular_escenario(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_simulaciones_get_factor(JSONB, TEXT, TEXT, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';
