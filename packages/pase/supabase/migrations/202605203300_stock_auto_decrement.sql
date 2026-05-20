-- ═══════════════════════════════════════════════════════════════════════════
-- Auto-decrement de stock al cobrar venta
--
-- Cuando una venta pasa a `cobrada`, para cada item con receta vigente
-- inserta movimientos `salida_venta` que descuentan stock de cada insumo
-- (cantidad × (1 + merma_pct/100)) × cantidad_vendida.
--
-- ¿Por qué al cobrar y no al enviar?
--   - "Enviar" puede revertirse (se cancela, manager override).
--   - "Cobrar" es transaccionalmente final. El COGS queda firme.
--   - Si después se anula la venta, otro trigger revierte los movimientos.
--
-- Idempotencia: cada movimiento por item de venta queda registrado con
-- fuente_tipo='venta_pos_item' + fuente_id=ventas_pos_items.id. Si se llama
-- dos veces, se detecta y skip.
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
BEGIN
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM ventas_pos WHERE id = p_venta_id AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

  -- Para cada item de la venta NO anulado:
  FOR v_item IN
    SELECT vpi.id AS item_id, vpi.item_id AS catalog_item_id, vpi.cantidad
      FROM ventas_pos_items vpi
     WHERE vpi.venta_id = p_venta_id
       AND vpi.deleted_at IS NULL
       AND vpi.estado != 'anulado'
       -- Idempotency: si ya hay movimiento con fuente=este item, skip
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos im
          WHERE im.fuente_tipo = 'venta_pos_item'
            AND im.fuente_id = vpi.id
            AND im.deleted_at IS NULL
       )
  LOOP
    -- Buscar receta activa del item. Si no tiene, no descontamos nada.
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
      -- preferir local-specific sobre global
      ORDER BY r.local_id NULLS LAST
      LIMIT 100 -- no debería haber más de N insumos por receta, pero por las dudas
    LOOP
      -- cantidad_consumida = (cantidad_por_receta / rendimiento) * (1 + merma/100) * cantidad_vendida
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
GRANT EXECUTE ON FUNCTION fn_aplicar_stock_venta(BIGINT) TO authenticated;

-- ─── Trigger: cuando una venta pasa a 'cobrada' aplica el decrement ──────
CREATE OR REPLACE FUNCTION fn_trg_venta_cobrada_stock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = 'cobrada' AND (OLD.estado IS NULL OR OLD.estado != 'cobrada') THEN
    PERFORM fn_aplicar_stock_venta(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venta_cobrada_stock ON ventas_pos;
CREATE TRIGGER trg_venta_cobrada_stock
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  WHEN (NEW.estado = 'cobrada')
  EXECUTE FUNCTION fn_trg_venta_cobrada_stock();

-- ─── Revertir stock si la venta se anula ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_revertir_stock_venta(p_venta_id BIGINT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Inserta movimientos opuestos para cada salida_venta vinculada a items
  -- de esta venta. NO borra los originales (audit).
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  )
  SELECT
    im.tenant_id, im.local_id, im.insumo_id, 'entrada_devolucion',
    -im.cantidad,  -- signo opuesto
    im.costo_unitario,
    'Reverso anulación venta #' || p_venta_id,
    'venta_pos_item_revert', im.fuente_id
  FROM insumo_movimientos im
  INNER JOIN ventas_pos_items vpi ON vpi.id = im.fuente_id
  WHERE vpi.venta_id = p_venta_id
    AND im.tipo = 'salida_venta'
    AND im.fuente_tipo = 'venta_pos_item'
    AND im.deleted_at IS NULL
    -- Idempotency: no duplicar reversos
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
GRANT EXECUTE ON FUNCTION fn_revertir_stock_venta(BIGINT) TO authenticated;

-- Trigger reverso: cuando venta pasa a 'anulada' habiendo estado en 'cobrada'
CREATE OR REPLACE FUNCTION fn_trg_venta_anulada_stock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = 'anulada' AND OLD.estado = 'cobrada' THEN
    PERFORM fn_revertir_stock_venta(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venta_anulada_stock ON ventas_pos;
CREATE TRIGGER trg_venta_anulada_stock
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  WHEN (NEW.estado = 'anulada')
  EXECUTE FUNCTION fn_trg_venta_anulada_stock();

NOTIFY pgrst, 'reload schema';
