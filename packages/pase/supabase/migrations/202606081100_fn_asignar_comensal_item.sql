-- 202606081100_fn_asignar_comensal_item.sql
--
-- Order-by-seat (increment 2): RPC para asignar un ítem de venta a un comensal.
-- Es solo agrupación de cuenta (no toca cocina ni totales), por eso:
--   - Se permite en cualquier estado del ítem antes de cobrar (incluso enviado/
--     listo) — útil para dividir la cuenta al momento de pagar.
--   - p_comensal = 0 → vuelve a "compartido" (NULL). 1..50 → comensal N.
-- Auth: permiso comanda.ventas.cobrar + assert del local (igual que el resto).

CREATE OR REPLACE FUNCTION fn_asignar_comensal_item(
  p_item_id BIGINT,
  p_comensal INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  IF p_comensal IS NULL OR p_comensal < 0 OR p_comensal > 50 THEN
    RAISE EXCEPTION 'COMENSAL_INVALIDO';
  END IF;

  SELECT local_id INTO v_local_id
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos_items
     SET comensal = CASE WHEN p_comensal = 0 THEN NULL ELSE p_comensal END,
         updated_at = NOW()
   WHERE id = p_item_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_asignar_comensal_item(BIGINT, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
