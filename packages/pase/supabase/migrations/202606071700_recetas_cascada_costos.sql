-- 202606071700_recetas_cascada_costos.sql
-- Pieza B — Catálogo en PASE · Fase 1 (cascada de costos).
-- Spec base: docs/superpowers/specs/2026-05-28-catalogo-recetas-rediseno.md
--
-- Hoy `items.costo_actual` NO se actualiza solo cuando cambia una receta o el
-- costo de un insumo. Esta migración cierra la cascada:
--   1. fn_recalc_costo_item(item): recalcula items.costo_actual desde su receta
--      (usa fn_calcular_costo_receta recursivo / rendimiento) y CASCADEA hacia
--      arriba a las recetas que usan ese item como sub-receta (prep_item).
--   2. Trigger en insumos AFTER UPDATE OF costo_actual → recalcula los items
--      cuyas recetas usan ese insumo (y por la cascada, sus padres).
--
-- Así: cambia una materia prima → trg_mp_recalc_insumo actualiza el insumo →
-- este trigger actualiza los items → y la receta del editor recalcula al guardar.

-- ── 1. Recalcular el costo de un item desde su receta + cascada a padres ──
CREATE OR REPLACE FUNCTION fn_recalc_costo_item(p_item_id bigint, p_depth integer DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant     uuid;
  v_receta_id  bigint;
  v_rend       numeric;
  v_total      numeric;
  v_unit       numeric;
  v_parent     record;
BEGIN
  IF p_depth > 10 THEN RETURN; END IF;  -- guarda anti-ciclo

  SELECT tenant_id INTO v_tenant FROM items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_tenant IS NULL THEN RETURN; END IF;
  -- Si hay contexto de auth (llamada del frontend / acción de un usuario), debe
  -- ser del mismo tenant. Sin contexto (trigger interno) se permite.
  IF auth_tenant_id() IS NOT NULL AND auth_tenant_id() <> v_tenant THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  -- Costo por porción = costo total de la receta / rendimiento.
  SELECT r.id, NULLIF(r.rendimiento, 0)
    INTO v_receta_id, v_rend
    FROM recetas r
   WHERE r.item_id = p_item_id AND r.activa = TRUE AND r.deleted_at IS NULL
   LIMIT 1;

  IF v_receta_id IS NOT NULL THEN
    v_total := fn_calcular_costo_receta(v_receta_id, 0);
    v_unit  := COALESCE(v_total, 0) / COALESCE(v_rend, 1);
    UPDATE items
       SET costo_actual = ROUND(COALESCE(v_unit, 0), 4),
           costo_actualizado_at = now()
     WHERE id = p_item_id
       AND COALESCE(costo_actual, -1) IS DISTINCT FROM ROUND(COALESCE(v_unit, 0), 4);
  END IF;

  -- Cascada hacia arriba: items cuyas recetas usan ESTE item como sub-receta.
  FOR v_parent IN
    SELECT DISTINCT r.item_id
      FROM receta_insumos ri
      JOIN recetas r ON r.id = ri.receta_id
     WHERE ri.prep_item_id = p_item_id
       AND ri.deleted_at IS NULL
       AND r.deleted_at IS NULL
       AND r.activa = TRUE
       AND r.item_id <> p_item_id
  LOOP
    PERFORM fn_recalc_costo_item(v_parent.item_id, p_depth + 1);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION fn_recalc_costo_item(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_recalc_costo_item(bigint, integer) TO authenticated;

-- ── 2. Cuando cambia el costo de un insumo, recalcular los items que lo usan ──
CREATE OR REPLACE FUNCTION fn_trg_insumo_costo_cascada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item record;
BEGIN
  IF NEW.costo_actual IS NOT DISTINCT FROM OLD.costo_actual THEN RETURN NEW; END IF;
  FOR v_item IN
    SELECT DISTINCT r.item_id
      FROM receta_insumos ri
      JOIN recetas r ON r.id = ri.receta_id
     WHERE ri.insumo_id = NEW.id
       AND ri.deleted_at IS NULL
       AND r.deleted_at IS NULL
       AND r.activa = TRUE
  LOOP
    PERFORM fn_recalc_costo_item(v_item.item_id, 0);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_insumo_costo_cascada ON insumos;
CREATE TRIGGER trg_insumo_costo_cascada
  AFTER UPDATE OF costo_actual ON insumos
  FOR EACH ROW EXECUTE FUNCTION fn_trg_insumo_costo_cascada();

NOTIFY pgrst, 'reload schema';
