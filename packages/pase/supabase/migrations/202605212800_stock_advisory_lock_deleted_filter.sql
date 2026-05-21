-- ═══════════════════════════════════════════════════════════════════════════
-- MED-1 + MED-2 Auditoría 2026-05-21
--
-- MED-1: fn_aplicar_stock_venta itera receta sin lockear filas de
-- receta_insumos. Si alguien edita la receta mientras se cobra una venta,
-- el snapshot del costo + cantidad queda inconsistente. Probabilidad baja
-- (la receta se edita poco) pero impacto alto si pasa.
-- Fix: pg_advisory_xact_lock por receta antes del loop interno.
--
-- MED-2: fn_revertir_stock_venta no filtra vpi.deleted_at IS NULL en el
-- JOIN. Si un item ya está soft-deleted, igual hace el reverso. Romper la
-- simetría con fn_aplicar_stock_venta (que sí filtra) es riesgoso.
-- Fix: agregar AND vpi.deleted_at IS NULL al JOIN.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_aplicar_stock_venta(p_venta_id BIGINT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_item RECORD;
  v_insumo RECORD;
  v_cantidad_consumida NUMERIC(12, 4);
  v_movs INTEGER := 0;
  v_receta_id BIGINT;
BEGIN
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM ventas_pos WHERE id = p_venta_id AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

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
    -- MED-1 FIX: advisory lock por catalog_item_id (serializa lecturas
    -- concurrentes de la misma receta). Si alguien edita la receta
    -- justo mientras se aplica, espera en este lock hasta que termine.
    -- Se libera automáticamente al final de la transacción.
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
$$;

-- ─── MED-2: fn_revertir_stock_venta filtrar deleted_at ───────────────────
CREATE OR REPLACE FUNCTION fn_revertir_stock_venta(p_venta_id BIGINT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  )
  SELECT
    im.tenant_id, im.local_id, im.insumo_id, 'entrada_devolucion',
    -im.cantidad,
    im.costo_unitario,
    'Reverso anulación venta #' || p_venta_id,
    'venta_pos_item_revert', im.fuente_id
  FROM insumo_movimientos im
  INNER JOIN ventas_pos_items vpi ON vpi.id = im.fuente_id
  WHERE vpi.venta_id = p_venta_id
    AND vpi.deleted_at IS NULL  -- MED-2 FIX: simetría con fn_aplicar_stock_venta
    AND im.tipo = 'salida_venta'
    AND im.fuente_tipo = 'venta_pos_item'
    AND im.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM insumo_movimientos im2
       WHERE im2.fuente_tipo = 'venta_pos_item_revert'
         AND im2.fuente_id = im.fuente_id
         AND im2.deleted_at IS NULL
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
