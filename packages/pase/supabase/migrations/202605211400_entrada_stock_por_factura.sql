-- ═══════════════════════════════════════════════════════════════════════════
-- Entrada automática de stock cuando se carga una factura
--
-- Visión PASE original: las facturas son la "puerta de entrada" del stock.
-- Hoy el sistema solo actualiza el PRECIO del insumo al cargar factura (via
-- trg_factura_item_actualiza_mp), pero NO sube el stock. Por eso el panel
-- de stock siempre estaba en negativo o desactualizado.
--
-- Este fix cierra esa puerta: cuando un factura_item tiene materia_prima_id
-- vinculada, automáticamente:
--   1. Convierte la cantidad de la factura (en unidad_compra) a unidad del
--      insumo, usando materias_primas.factor_conversion.
--   2. Calcula el costo unitario en unidad del insumo (precio / factor).
--   3. Inserta movimiento `entrada_compra` con local_id de la factura.
--
-- Esto habilita después:
--   - CMV real (sin esto, no sabemos cuánto entró por compras del período)
--   - Brecha de eficiencia honesta (Real − Teórico)
--   - Panel de stock con valores positivos sin necesidad de ajustes manuales
--
-- Idempotency: fuente_tipo='factura_item' + fuente_id=factura_items.id.
-- Si la factura se re-procesa o el item se edita, no duplica.
--
-- Por ahora SOLO INSERT. Edición de cantidad / anulación de factura se
-- maneja después con triggers de UPDATE/DELETE (próxima iteración).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_trg_factura_item_entrada_stock()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_insumo_id BIGINT;
  v_factor_conv NUMERIC;
  v_cantidad_insumo NUMERIC(14, 4);
  v_costo_unitario NUMERIC(14, 4);
BEGIN
  -- Solo actúa si hay vinculación a materia_prima (un usuario puede cargar
  -- una factura sin vincular sus items — eso pasa cuando no le importa el
  -- stock, ej. servicios).
  IF NEW.materia_prima_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotency: si ya hay movimiento con esta fuente, no duplicar
  IF EXISTS (
    SELECT 1 FROM insumo_movimientos
    WHERE fuente_tipo = 'factura_item'
      AND fuente_id = NEW.id::BIGINT
      AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  -- Saca local_id + tenant_id de la factura padre
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM facturas
   WHERE id = NEW.factura_id;
  -- Si la factura no tiene local_id (raro pero posible en cargas antiguas),
  -- no podemos saber a qué stock por local sumar. Saltamos.
  IF v_local_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Saca insumo + factor_conversion de la materia_prima
  -- factor_conversion = cuántas unidades del insumo hay en 1 unidad_compra
  -- Ej: harina vendida por bolsa de 25kg → factor=25, insumo se mide en kg
  SELECT insumo_id, COALESCE(factor_conversion, 1)
    INTO v_insumo_id, v_factor_conv
    FROM materias_primas
   WHERE id = NEW.materia_prima_id;

  IF v_insumo_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- cantidad_insumo = cantidad_factura × factor
  -- Ej: 5 bolsas × 25kg/bolsa = 125 kg
  v_cantidad_insumo := COALESCE(NEW.cantidad, 0) * v_factor_conv;

  -- costo_unitario_insumo = precio_factura / factor
  -- Ej: $50.000/bolsa ÷ 25 = $2.000/kg
  v_costo_unitario := COALESCE(NEW.precio_unitario, 0) / GREATEST(v_factor_conv, 0.0001);

  IF v_cantidad_insumo <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, v_local_id, v_insumo_id, 'entrada_compra',
    v_cantidad_insumo, v_costo_unitario,
    'Entrada auto por factura ' || NEW.factura_id,
    'factura_item', NEW.id::BIGINT
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_factura_item_entrada_stock ON factura_items;
CREATE TRIGGER trg_factura_item_entrada_stock
  AFTER INSERT ON factura_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_factura_item_entrada_stock();

-- ─── Reversión de stock al anular factura ─────────────────────────────────
-- Cuando una factura pasa a estado='anulada', revertimos las entradas que
-- se habían generado por sus items. Idempotent: solo revierte una vez.

CREATE OR REPLACE FUNCTION fn_revertir_stock_factura(p_factura_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revertidos INTEGER := 0;
  v_mov RECORD;
BEGIN
  -- Buscar movimientos de entrada_compra cuya fuente es algún item de esta factura
  FOR v_mov IN
    SELECT im.id, im.tenant_id, im.local_id, im.insumo_id, im.cantidad, im.costo_unitario
      FROM insumo_movimientos im
     WHERE im.fuente_tipo = 'factura_item'
       AND im.fuente_id IN (SELECT id::BIGINT FROM factura_items WHERE factura_id = p_factura_id)
       AND im.deleted_at IS NULL
       -- Idempotency: no revertir dos veces
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos rev
         WHERE rev.fuente_tipo = 'reversion_factura'
           AND rev.fuente_id = im.id
           AND rev.deleted_at IS NULL
       )
  LOOP
    INSERT INTO insumo_movimientos (
      tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
      motivo, fuente_tipo, fuente_id
    ) VALUES (
      v_mov.tenant_id, v_mov.local_id, v_mov.insumo_id, 'entrada_devolucion',
      -v_mov.cantidad, v_mov.costo_unitario,
      'Reversión anulación factura ' || p_factura_id,
      'reversion_factura', v_mov.id
    );
    v_revertidos := v_revertidos + 1;
  END LOOP;

  RETURN v_revertidos;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_revertir_stock_factura(TEXT) TO authenticated;

-- Trigger sobre facturas: cuando estado pasa a 'anulada', revertir.
CREATE OR REPLACE FUNCTION fn_trg_factura_anulada_stock()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.estado = 'anulada' AND (OLD.estado IS DISTINCT FROM 'anulada') THEN
    PERFORM fn_revertir_stock_factura(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_factura_anulada_stock ON facturas;
CREATE TRIGGER trg_factura_anulada_stock
  AFTER UPDATE OF estado ON facturas
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_factura_anulada_stock();

NOTIFY pgrst, 'reload schema';
