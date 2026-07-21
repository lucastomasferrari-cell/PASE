-- Drop materias_primas.merma_pct (DEPRECADO)
-- ─────────────────────────────────────────────────────────────────────────
-- El rendimiento/merma NO se aplica en la recepción de la compra: el stock
-- entra "as-bought" (precio ÷ factor_conversion) y la merma vive en la línea
-- de receta (receta_insumos.merma_pct), que se aplica al CONSUMIR en la venta.
-- La columna materias_primas.merma_pct quedó dormida: el fn_recalc_costo_insumo
-- vigente ya calcula costo como precio_actual/factor_conversion sin merma.
-- La sacamos para que nadie cargue un rinde ahí creyendo que hace algo.
-- (Decisión 21-jul, apoyada en cómo lo hacen Toast/Apicbase/MarketMan.)

-- 1. Recrear el trigger de recálculo sin la referencia a merma_pct.
CREATE OR REPLACE FUNCTION public.fn_trg_mp_recalc_insumo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_recalc_costo_insumo(NEW.insumo_id);
  ELSIF TG_OP = 'UPDATE' AND (
    OLD.precio_actual IS DISTINCT FROM NEW.precio_actual OR
    OLD.factor_conversion IS DISTINCT FROM NEW.factor_conversion OR
    OLD.activa IS DISTINCT FROM NEW.activa OR
    OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR
    OLD.insumo_id IS DISTINCT FROM NEW.insumo_id
  ) THEN
    PERFORM fn_recalc_costo_insumo(NEW.insumo_id);
    IF OLD.insumo_id IS DISTINCT FROM NEW.insumo_id THEN
      PERFORM fn_recalc_costo_insumo(OLD.insumo_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Drop constraint + columna.
ALTER TABLE public.materias_primas DROP CONSTRAINT IF EXISTS chk_mp_merma_pct;
ALTER TABLE public.materias_primas DROP COLUMN IF EXISTS merma_pct;
