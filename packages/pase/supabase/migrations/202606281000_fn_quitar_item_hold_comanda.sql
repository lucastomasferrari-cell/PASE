-- ═══════════════════════════════════════════════════════════════════════════
-- fn_quitar_item_hold_comanda — borrar item en hold sin pasar por manager
-- 28-jun-2026
--
-- Antes el "tacho" del POS llamaba fn_modificar_item_comanda con cantidad=0,
-- lo que dejaba la fila con cantidad=0 visible en la lista (bug reportado).
-- Para items YA ENVIADOS a cocina sigue corriendo fn_anular_item_comanda
-- (requiere manager + motivo). Para items en HOLD (todavía no mandados a
-- cocina), esta RPC nueva hace soft-delete sin fricciones.
--
-- Estado válido para borrar: solo 'hold'. Otros estados (enviado, listo,
-- entregado, anulado) tiran error.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION fn_quitar_item_hold_comanda(
  p_item_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_estado   TEXT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT venta_id, local_id, estado
    INTO v_venta_id, v_local_id, v_estado
    FROM ventas_pos_items
   WHERE id = p_item_id AND deleted_at IS NULL;

  IF v_venta_id IS NULL THEN
    RAISE EXCEPTION 'ITEM_NO_ENCONTRADO';
  END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado <> 'hold' THEN
    RAISE EXCEPTION 'ITEM_NO_HOLD: estado %. Para items enviados usar fn_anular_item_comanda (requiere manager + motivo).', v_estado;
  END IF;

  -- Soft-delete: marca deleted_at y baja a 0 para que el recálculo de total
  -- excluya este item.
  UPDATE ventas_pos_items
     SET deleted_at = NOW(),
         cantidad   = 0,
         subtotal   = 0,
         updated_at = NOW()
   WHERE id = p_item_id;

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_quitar_item_hold_comanda(BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.routines
          WHERE routine_name = 'fn_quitar_item_hold_comanda') = 1,
         'fn_quitar_item_hold_comanda no creada';
  RAISE NOTICE '✓ fn_quitar_item_hold_comanda listo';
END $$;
