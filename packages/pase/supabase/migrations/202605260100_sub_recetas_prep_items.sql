-- ─────────────────────────────────────────────────────────────────────────
-- Sub-recetas / Prep Items: recetas que se usan como ingredientes en otras
-- ─────────────────────────────────────────────────────────────────────────
--
-- Implementa el ticket "Sub-recetas (prep items) no soportadas" anotado el
-- 24-may. Patrón industria (Toast Inventory, MarginEdge): existen 2 tipos
-- de recetas:
--   - Recipe / menu item:  ítem vendible (un sushi, un ramen)
--   - Prep recipe / prep item: preparación intermedia (caldo, masa, salsa)
--     que se usa DENTRO de otras recetas.
--
-- Antes: un caldo de cerdo que se usa en 5 ramenes distintos había que
-- replicar como receta de cada ramen → cambiar costo del cerdo = editar
-- 5 recetas. Ahora: defino "Caldo de cerdo" como prep item con SU receta,
-- y los 5 ramenes lo referencian. Cambiar costo del cerdo = recalcula
-- automático en los 5.
--
-- Estructura:
-- 1. `items.es_prep_item BOOLEAN DEFAULT false`: marca el item como
--    "no vendible directo, solo para usar en recetas de otros items".
--    Si es true: visible_pos/qr/tienda = false (no aparece en POS).
-- 2. `receta_insumos.prep_item_id INTEGER NULL`: si está poblado, esta
--    "línea" de receta usa un prep en lugar de un insumo crudo. Si está
--    null, sigue siendo insumo crudo (campo `insumo_id` actual).
--
-- Restricción semántica (CHECK): cada fila de receta_insumos tiene
-- EXACTAMENTE UNO seteado (insumo_id XOR prep_item_id).
--
-- Cálculo de costo recursivo (helper RPC `fn_calcular_costo_receta`):
-- Para cada línea:
--   - Si insumo_id: costo = insumo.costo_actual × cantidad × (1+merma_pct/100)
--   - Si prep_item_id: costo = fn_calcular_costo_receta(prep.id) / prep.rendimiento × cantidad
-- (recursivo, con depth limit defensivo para evitar ciclos)
--
-- NOTA: la UI para definir prep items via /menu/recetas se construye
-- después en una iteración separada. Esta migration prepara el schema +
-- el cálculo de costo recursivo, no rompe nada existente.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Paso 1: agregar flag a items ─────────────────────────────────────────
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS es_prep_item BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN items.es_prep_item IS
  'TRUE = este item es una "preparación" (caldo, masa, salsa) que se usa '
  'DENTRO de recetas de otros items. NO se vende directo. Su receta '
  'define el costo. Otros items pueden referenciarlo via '
  'receta_insumos.prep_item_id. Patrón Toast/MarginEdge.';

-- Trigger: si es_prep_item=true, forzar visible_pos/qr/tienda = false.
CREATE OR REPLACE FUNCTION fn_trg_prep_item_no_visible()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.es_prep_item = TRUE THEN
    NEW.visible_pos := FALSE;
    NEW.visible_qr := FALSE;
    NEW.visible_tienda := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prep_item_no_visible ON items;
CREATE TRIGGER trg_prep_item_no_visible
  BEFORE INSERT OR UPDATE OF es_prep_item ON items
  FOR EACH ROW EXECUTE FUNCTION fn_trg_prep_item_no_visible();

-- ─── Paso 2: agregar prep_item_id a receta_insumos ────────────────────────
ALTER TABLE receta_insumos
  ADD COLUMN IF NOT EXISTS prep_item_id INTEGER NULL REFERENCES items(id) ON DELETE RESTRICT;

COMMENT ON COLUMN receta_insumos.prep_item_id IS
  'Si está poblado: esta línea de receta usa un prep item (caldo/salsa/etc.) '
  'en lugar de un insumo crudo. XOR con insumo_id. La cantidad se interpreta '
  'en porciones del prep (ej: 0.5 porciones de caldo cerdo).';

-- ─── Paso 3: CHECK constraint XOR (insumo_id OR prep_item_id, not both) ──
-- IF NOT EXISTS porque ALTER TABLE ADD CONSTRAINT no soporta IF NOT EXISTS
-- directamente — usamos DO block defensivo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_receta_insumos_xor_insumo_prep'
      AND conrelid = 'receta_insumos'::regclass
  ) THEN
    -- Permitimos que insumo_id sea NULL (no era NOT NULL antes? veamos).
    -- Si era NOT NULL, hay que dropearlo primero.
    BEGIN
      ALTER TABLE receta_insumos ALTER COLUMN insumo_id DROP NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL; -- ya era nullable
    END;

    ALTER TABLE receta_insumos
      ADD CONSTRAINT chk_receta_insumos_xor_insumo_prep
      CHECK (
        (insumo_id IS NOT NULL AND prep_item_id IS NULL) OR
        (insumo_id IS NULL AND prep_item_id IS NOT NULL)
      );
  END IF;
END $$;

-- ─── Paso 4: RPC recursiva fn_calcular_costo_receta ───────────────────────
-- Calcula el costo TOTAL de una receta (suma de líneas) incluyendo prep
-- items que pueden ser otras recetas. Recursión con depth limit defensivo
-- para evitar ciclos (ej: prep A usa prep B usa prep A → infinite loop).
CREATE OR REPLACE FUNCTION public.fn_calcular_costo_receta(
  p_receta_id BIGINT,
  p_depth INTEGER DEFAULT 0
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC := 0;
  v_linea RECORD;
  v_receta_prep_id BIGINT;
  v_rendimiento_prep NUMERIC;
  v_costo_prep_total NUMERIC;
BEGIN
  -- Depth limit defensivo: evita ciclos de sub-recetas (A → B → A).
  IF p_depth > 10 THEN
    RAISE WARNING 'fn_calcular_costo_receta: max depth alcanzada (posible ciclo) en receta_id=%', p_receta_id;
    RETURN 0;
  END IF;

  FOR v_linea IN
    SELECT ri.cantidad, ri.merma_pct, ri.insumo_id, ri.prep_item_id,
           i.costo_actual AS insumo_costo
    FROM receta_insumos ri
    LEFT JOIN insumos i ON i.id = ri.insumo_id AND i.deleted_at IS NULL
    WHERE ri.receta_id = p_receta_id
      AND ri.deleted_at IS NULL
  LOOP
    IF v_linea.insumo_id IS NOT NULL THEN
      -- Línea con insumo crudo: costo = cantidad × costo_actual × (1 + merma%)
      v_total := v_total + (
        COALESCE(v_linea.cantidad, 0)
        * COALESCE(v_linea.insumo_costo, 0)
        * (1 + COALESCE(v_linea.merma_pct, 0) / 100.0)
      );
    ELSIF v_linea.prep_item_id IS NOT NULL THEN
      -- Línea con prep item: buscar la receta activa de ese prep y
      -- calcular costo recursivo. Dividir por rendimiento del prep.
      SELECT r.id, r.rendimiento INTO v_receta_prep_id, v_rendimiento_prep
        FROM recetas r
       WHERE r.item_id = v_linea.prep_item_id
         AND r.activa = TRUE
         AND r.deleted_at IS NULL
       LIMIT 1;

      IF v_receta_prep_id IS NULL THEN
        -- Prep item sin receta definida → costo 0 (no podemos calcularlo).
        -- En UI mostrar warning.
        CONTINUE;
      END IF;

      v_costo_prep_total := fn_calcular_costo_receta(v_receta_prep_id, p_depth + 1);
      v_total := v_total + (
        v_costo_prep_total / NULLIF(v_rendimiento_prep, 0)
        * COALESCE(v_linea.cantidad, 0)
        * (1 + COALESCE(v_linea.merma_pct, 0) / 100.0)
      );
    END IF;
  END LOOP;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.fn_calcular_costo_receta IS
  'Calcula el costo TOTAL de una receta, soportando sub-recetas (prep items) '
  'recursivamente. Si la línea referencia un insumo crudo: usa costo_actual. '
  'Si referencia un prep item: busca su receta activa y calcula recursivo. '
  'Depth limit 10 para evitar ciclos. Patrón Toast/MarginEdge.';
