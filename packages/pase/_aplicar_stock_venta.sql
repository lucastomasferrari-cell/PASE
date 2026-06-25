CREATE OR REPLACE FUNCTION public.fn_aplicar_stock_venta(p_venta_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_item RECORD;
  v_insumo RECORD;
  v_cantidad_consumida NUMERIC(12, 4);
  v_movs INTEGER := 0;
BEGIN
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM ventas_pos WHERE id = p_venta_id AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

  -- AUDIT F2B #8: defense-in-depth cross-tenant.
  PERFORM fn_assert_local_autorizado(v_local_id);

  FOR v_item IN
    SELECT vpi.id AS item_id, vpi.item_id AS catalog_item_id, vpi.cantidad
      FROM ventas_pos_items vpi
     WHERE vpi.venta_id = p_venta_id
       AND vpi.deleted_at IS NULL
       AND vpi.estado != 'anulado'
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos im
          WHERE im.fuente_tipo = 'venta_pos_item'
            AND im.fuente_id = vpi.id
            AND im.deleted_at IS NULL
       )
  LOOP
    PERFORM pg_advisory_xact_lock(v_item.catalog_item_id);

    FOR v_insumo IN
      SELECT
        ri.insumo_id,
        ri.cantidad AS cantidad_por_receta,
        ri.merma_pct,
        r.rendimiento,
        i.costo_actual
      FROM recetas r
      INNER JOIN receta_insumos ri ON ri.receta_id = r.id AND ri.deleted_at IS NULL
      INNER JOIN insumos i ON i.id = ri.insumo_id
      WHERE r.item_id = v_item.catalog_item_id
        AND r.tenant_id = v_tenant_id
        AND r.activa = TRUE
        AND r.deleted_at IS NULL
        AND (r.local_id IS NULL OR r.local_id = v_local_id)
      ORDER BY r.local_id NULLS LAST
      LIMIT 100
    LOOP
      v_cantidad_consumida := (v_insumo.cantidad_por_receta / GREATEST(v_insumo.rendimiento, 1))
                              * (1 + COALESCE(v_insumo.merma_pct, 0) / 100)
                              * v_item.cantidad;

      INSERT INTO insumo_movimientos (
        tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
        motivo, fuente_tipo, fuente_id
      ) VALUES (
        v_tenant_id, v_local_id, v_insumo.insumo_id, 'salida_venta',
        -v_cantidad_consumida, v_insumo.costo_actual,
        'Auto-decrement venta #' || p_venta_id,
        'venta_pos_item', v_item.item_id
      );
      v_movs := v_movs + 1;
    END LOOP;
  END LOOP;

  RETURN v_movs;
END;
$function$
