-- ═══════════════════════════════════════════════════════════════════════════
-- Auto-86 con CMV — Toast feature top ROI
-- ═══════════════════════════════════════════════════════════════════════════
-- Cuando un insumo se marca como "sin stock", todos los items que tienen
-- una receta vigente usándolo pasan automáticamente a estado='agotado'
-- (con motivo "Auto-86: sin stock de X").
--
-- Diseño minimal: en lugar de tracking de stock numérico (que requiere
-- decrement por venta + control de mermas), usamos un BOOLEAN simple
-- `stock_disponible` que el cocinero/dueño togglea desde la UI cuando ve
-- que se quedó sin un insumo.
--
-- Cuando vuelve a TRUE, NO desmarca items automáticamente — otros insumos
-- de la misma receta podrían seguir faltando. El cajero los desmarca
-- manual desde /menu/disponibilidad.

-- ─── 1. Columna stock_disponible en insumos ──────────────────────────────
ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS stock_disponible BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN insumos.stock_disponible IS
  'Auto-86 CMV: cuando es FALSE, el trigger fn_trg_auto_86_por_insumo marca items dependientes como agotado.';

-- ─── 2. Trigger de propagación ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_auto_86_por_insumo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Solo actuar cuando el flag transiciona de TRUE/NULL → FALSE.
  IF NEW.stock_disponible = FALSE AND (OLD.stock_disponible IS NULL OR OLD.stock_disponible = TRUE) THEN
    UPDATE items i SET
      estado = 'agotado',
      agotado_motivo = 'Auto-86: sin stock de ' || NEW.nombre,
      agotado_at = NOW(),
      updated_at = NOW()
    WHERE i.estado = 'disponible'
      AND i.deleted_at IS NULL
      AND i.tenant_id = NEW.tenant_id
      AND i.id IN (
        SELECT DISTINCT r.item_id
        FROM recetas r
        JOIN receta_insumos ri ON ri.receta_id = r.id
        WHERE ri.insumo_id = NEW.id
          AND r.activa = TRUE
          AND r.deleted_at IS NULL
          AND ri.deleted_at IS NULL
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      RAISE NOTICE 'Auto-86 propagó stock de insumo % a % items', NEW.nombre, v_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_86_por_insumo ON insumos;
CREATE TRIGGER trg_auto_86_por_insumo
  AFTER UPDATE OF stock_disponible ON insumos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_auto_86_por_insumo();

-- ─── 3. RPC helper para togglear desde UI ────────────────────────────────
-- Evita UPDATE directo desde el frontend a la columna (consistencia +
-- audit en el futuro). NO entra en lista C4 — insumos no es financiera.
CREATE OR REPLACE FUNCTION fn_toggle_stock_insumo(
  p_insumo_id BIGINT,
  p_disponible BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_es_superadmin()
          OR auth_tiene_permiso('comanda.catalogo.editar')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_MARCAR_AGOTADO';
  END IF;
  UPDATE insumos
    SET stock_disponible = p_disponible, updated_at = NOW()
  WHERE id = p_insumo_id
    AND (auth_es_superadmin() OR tenant_id = auth_tenant_id());
  IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_toggle_stock_insumo(BIGINT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION fn_toggle_stock_insumo IS
  'Auto-86: setea insumos.stock_disponible. Trigger propaga a items con recetas dependientes.';
