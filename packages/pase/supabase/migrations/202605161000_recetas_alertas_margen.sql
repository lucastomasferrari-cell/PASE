-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 1 competitor F #4 — Auto-recosting de recetas + alertas de margen
--
-- Contexto: cuando el costo de un insumo sube, el costo (CMV) de cada receta
-- que lo usa también sube. Si el cajero no actualiza el precio del item, el
-- margen del plato baja silenciosamente — Toast/MarketMan lo llaman "silent
-- margin erosion" y es uno de los killers de rentabilidad gastronómica.
--
-- Acá:
--   - Trigger AFTER UPDATE OF costo_actual ON insumos → recalcula el costo
--     vivo de cada receta afectada, compara contra precio_madre del item,
--     y si el margen cae > umbral (default 5 puntos porcentuales) genera
--     una alerta en `recetas_alertas_margen`.
--   - La alerta NO modifica el precio del item. Solo notifica. El dueño
--     decide en UI: subir precio, asumir el margen menor, o reconocer/dismiss.
--   - RPC para listar alertas activas + reconocerlas.
--
-- Filosofía: NO tocar nada en silencio. Auto-recosting != auto-pricing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla recetas_alertas_margen ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS recetas_alertas_margen (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id          INTEGER NULL REFERENCES locales(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  receta_id         BIGINT NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
  -- Insumo que disparó la alerta (el que cambió costo)
  trigger_insumo_id BIGINT NULL REFERENCES insumos(id) ON DELETE SET NULL,

  -- Datos del cálculo (snapshot al momento del trigger):
  precio_actual     NUMERIC(12,2) NOT NULL,
  costo_anterior    NUMERIC(12,4) NOT NULL,
  costo_nuevo       NUMERIC(12,4) NOT NULL,
  margen_anterior_pct NUMERIC(6,2) NULL,  -- NULL si precio_actual = 0
  margen_nuevo_pct    NUMERIC(6,2) NULL,
  caida_pp          NUMERIC(6,2) NULL,    -- (margen_anterior - margen_nuevo) en puntos

  -- Acknowledgment
  reconocida_at     TIMESTAMPTZ NULL,
  reconocida_por    INTEGER NULL REFERENCES usuarios(id),
  reconocida_accion TEXT NULL CHECK (
    reconocida_accion IS NULL OR
    reconocida_accion IN ('precio_actualizado', 'asumido', 'dismiss')
  )
);

CREATE INDEX IF NOT EXISTS idx_recetas_alertas_tenant_activas
  ON recetas_alertas_margen(tenant_id, created_at DESC)
  WHERE reconocida_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recetas_alertas_item
  ON recetas_alertas_margen(item_id, created_at DESC);

ALTER TABLE recetas_alertas_margen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recetas_alertas_select ON recetas_alertas_margen;
CREATE POLICY recetas_alertas_select ON recetas_alertas_margen FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );
DROP POLICY IF EXISTS recetas_alertas_modify ON recetas_alertas_margen;
CREATE POLICY recetas_alertas_modify ON recetas_alertas_margen FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  );
DROP POLICY IF EXISTS recetas_alertas_service ON recetas_alertas_margen;
CREATE POLICY recetas_alertas_service ON recetas_alertas_margen FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE recetas_alertas_margen IS
  'Alertas auto-generadas cuando el costo de un insumo sube y empuja el margen de una receta a la baja > umbral. Generadas por trigger fn_recosting_alerta_margen al UPDATE de insumos.costo_actual. NO modifican el precio del item — solo notifican.';

-- ─── 2. Función helper: costo de receta a costos vivos ────────────────────
-- Calcula el costo por porción de una receta dado un mapa de costos de
-- insumos. p_costos_override permite simular "qué pasaría si este insumo
-- pasara a costar X" (usado por el trigger para calcular costo ANTERIOR
-- y NUEVO en la misma llamada).
CREATE OR REPLACE FUNCTION fn_calcular_costo_receta_porcion(
  p_receta_id BIGINT,
  p_costo_override_insumo_id BIGINT DEFAULT NULL,
  p_costo_override_valor     NUMERIC DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(
      SUM(
        ri.cantidad
        * COALESCE(
            CASE
              WHEN p_costo_override_insumo_id IS NOT NULL
                   AND ri.insumo_id = p_costo_override_insumo_id
                THEN p_costo_override_valor
              ELSE i.costo_actual
            END,
            0
          )
        * (1 + ri.merma_pct / 100.0)
      ) / NULLIF(r.rendimiento, 0),
      0
    )::NUMERIC
  FROM recetas r
  JOIN receta_insumos ri ON ri.receta_id = r.id AND ri.deleted_at IS NULL
  JOIN insumos i ON i.id = ri.insumo_id
  WHERE r.id = p_receta_id
    AND r.deleted_at IS NULL
  GROUP BY r.rendimiento;
$$;

REVOKE ALL ON FUNCTION fn_calcular_costo_receta_porcion(BIGINT, BIGINT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_calcular_costo_receta_porcion(BIGINT, BIGINT, NUMERIC) TO authenticated, service_role;

-- ─── 3. Trigger function: AFTER UPDATE OF costo_actual ON insumos ──────────
-- Para cada receta que usa este insumo:
--   - Calcula costo anterior (con OLD.costo_actual) y nuevo (con NEW)
--   - Busca precio_madre del item asociado
--   - Calcula margen_pct antes/después
--   - Si caída de margen >= 5pp (puntos porcentuales) → INSERT alerta
-- NO modifica precio_madre (eso es decisión del dueño).
CREATE OR REPLACE FUNCTION fn_recosting_alerta_margen()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_umbral_pp NUMERIC := 5;  -- caída mínima en puntos porcentuales para alertar
  v_rec RECORD;
  v_costo_ant NUMERIC;
  v_costo_nue NUMERIC;
  v_margen_ant NUMERIC;
  v_margen_nue NUMERIC;
  v_caida NUMERIC;
BEGIN
  -- Solo si costo realmente cambió y los dos son no-NULL
  IF NEW.costo_actual IS NULL OR OLD.costo_actual IS NULL THEN RETURN NEW; END IF;
  IF OLD.costo_actual IS NOT DISTINCT FROM NEW.costo_actual THEN RETURN NEW; END IF;
  -- Solo si SUBIÓ (bajadas no son problema de margen)
  IF NEW.costo_actual <= OLD.costo_actual THEN RETURN NEW; END IF;

  -- Iterar recetas activas que usan este insumo
  FOR v_rec IN
    SELECT
      r.id AS receta_id,
      r.item_id,
      r.local_id,
      r.tenant_id,
      i_item.precio_madre AS precio_madre
    FROM receta_insumos ri
    JOIN recetas r ON r.id = ri.receta_id
    JOIN items i_item ON i_item.id = r.item_id
    WHERE ri.insumo_id = NEW.id
      AND ri.deleted_at IS NULL
      AND r.deleted_at IS NULL
      AND r.activa = TRUE
  LOOP
    -- Costo anterior y nuevo de la receta entera
    v_costo_ant := fn_calcular_costo_receta_porcion(v_rec.receta_id, NEW.id, OLD.costo_actual);
    v_costo_nue := fn_calcular_costo_receta_porcion(v_rec.receta_id, NEW.id, NEW.costo_actual);

    -- Margen (NULL si precio_madre = 0)
    IF v_rec.precio_madre > 0 THEN
      v_margen_ant := ((v_rec.precio_madre - v_costo_ant) / v_rec.precio_madre) * 100;
      v_margen_nue := ((v_rec.precio_madre - v_costo_nue) / v_rec.precio_madre) * 100;
      v_caida := v_margen_ant - v_margen_nue;  -- positivo = baja de margen
    ELSE
      v_margen_ant := NULL;
      v_margen_nue := NULL;
      v_caida := NULL;
    END IF;

    -- Insertar alerta si caída >= umbral
    IF v_caida IS NOT NULL AND v_caida >= v_umbral_pp THEN
      INSERT INTO recetas_alertas_margen (
        tenant_id, local_id, item_id, receta_id, trigger_insumo_id,
        precio_actual, costo_anterior, costo_nuevo,
        margen_anterior_pct, margen_nuevo_pct, caida_pp
      ) VALUES (
        v_rec.tenant_id, v_rec.local_id, v_rec.item_id, v_rec.receta_id, NEW.id,
        v_rec.precio_madre, v_costo_ant, v_costo_nue,
        ROUND(v_margen_ant, 2), ROUND(v_margen_nue, 2), ROUND(v_caida, 2)
      );
    END IF;

    -- Best-effort: actualizar items.costo_actual al nuevo costo vivo
    -- (esto sí lo hacemos auto — es info, no decisión de precio).
    UPDATE items SET
      costo_actual = ROUND(v_costo_nue, 2),
      costo_actualizado_at = NOW()
    WHERE id = v_rec.item_id;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recosting_alerta_margen ON insumos;
CREATE TRIGGER trg_recosting_alerta_margen
  AFTER UPDATE OF costo_actual ON insumos
  FOR EACH ROW
  EXECUTE FUNCTION fn_recosting_alerta_margen();

COMMENT ON FUNCTION fn_recosting_alerta_margen IS
  'Trigger: al subir costo_actual de un insumo, recalcula costo de cada receta afectada, compara margen, alerta si cae > 5pp. También actualiza items.costo_actual (info, no precio).';

-- ─── 4. RPCs: listar alertas activas y reconocerlas ────────────────────────
CREATE OR REPLACE FUNCTION fn_alertas_margen_activas()
RETURNS TABLE (
  id BIGINT,
  created_at TIMESTAMPTZ,
  item_id INTEGER,
  item_nombre TEXT,
  item_emoji TEXT,
  receta_id BIGINT,
  trigger_insumo_id BIGINT,
  trigger_insumo_nombre TEXT,
  precio_actual NUMERIC,
  costo_anterior NUMERIC,
  costo_nuevo NUMERIC,
  margen_anterior_pct NUMERIC,
  margen_nuevo_pct NUMERIC,
  caida_pp NUMERIC,
  local_id INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.created_at,
    a.item_id,
    it.nombre,
    it.emoji,
    a.receta_id,
    a.trigger_insumo_id,
    ins.nombre,
    a.precio_actual,
    a.costo_anterior,
    a.costo_nuevo,
    a.margen_anterior_pct,
    a.margen_nuevo_pct,
    a.caida_pp,
    a.local_id
  FROM recetas_alertas_margen a
  JOIN items it ON it.id = a.item_id
  LEFT JOIN insumos ins ON ins.id = a.trigger_insumo_id
  WHERE a.tenant_id = auth_tenant_id()
    AND a.reconocida_at IS NULL
    AND (a.local_id IS NULL OR a.local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
  ORDER BY a.caida_pp DESC NULLS LAST, a.created_at DESC;
$$;

REVOKE ALL ON FUNCTION fn_alertas_margen_activas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_alertas_margen_activas() TO authenticated;

CREATE OR REPLACE FUNCTION fn_reconocer_alerta_margen(
  p_alerta_id BIGINT,
  p_accion TEXT  -- 'precio_actualizado' | 'asumido' | 'dismiss'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  IF p_accion NOT IN ('precio_actualizado', 'asumido', 'dismiss') THEN
    RAISE EXCEPTION 'ACCION_INVALIDA';
  END IF;
  UPDATE recetas_alertas_margen SET
    reconocida_at = NOW(),
    reconocida_por = auth_usuario_id(),
    reconocida_accion = p_accion
  WHERE id = p_alerta_id
    AND (auth_es_superadmin() OR tenant_id = v_tenant)
    AND reconocida_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ALERTA_NO_ENCONTRADA_O_YA_RECONOCIDA';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_reconocer_alerta_margen(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_reconocer_alerta_margen(BIGINT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
