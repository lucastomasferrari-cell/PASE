-- ============================================================
-- 202606120120_fecha_compra_factura.sql
-- Tier 1 #5 (informe 2026-06-11): la entrada de stock por compra
-- se fecha con la FECHA DE LA FACTURA, no con la fecha de carga.
-- Incluye backfill de movimientos históricos con tabla de backup
-- (reversible) — el CMV ya no usa snapshots, así que re-fechar es seguro.
-- ============================================================

BEGIN;

-- 1) Trigger v2: created_at = fecha de la factura ---------------------------
CREATE OR REPLACE FUNCTION fn_trg_factura_item_entrada_stock()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_factura_fecha DATE;
  v_insumo_id BIGINT;
  v_factor_conv NUMERIC;
  v_cantidad_insumo NUMERIC(14, 4);
  v_costo_unitario NUMERIC(14, 4);
BEGIN
  IF NEW.materia_prima_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM insumo_movimientos
    WHERE fuente_tipo = 'factura_item'
      AND fuente_id = NEW.id::BIGINT
      AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id, local_id, fecha INTO v_tenant_id, v_local_id, v_factura_fecha
    FROM facturas
   WHERE id = NEW.factura_id;
  IF v_local_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT insumo_id, COALESCE(factor_conversion, 1)
    INTO v_insumo_id, v_factor_conv
    FROM materias_primas
   WHERE id = NEW.materia_prima_id;

  IF v_insumo_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_cantidad_insumo := COALESCE(NEW.cantidad, 0) * v_factor_conv;
  v_costo_unitario := COALESCE(NEW.precio_unitario, 0) / GREATEST(v_factor_conv, 0.0001);

  IF v_cantidad_insumo <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, created_at
  ) VALUES (
    v_tenant_id, v_local_id, v_insumo_id, 'entrada_compra',
    v_cantidad_insumo, v_costo_unitario,
    'Entrada auto por factura ' || NEW.factura_id,
    'factura_item', NEW.id::BIGINT,
    COALESCE(v_factura_fecha::TIMESTAMPTZ, NOW())
  );

  RETURN NEW;
END;
$$;

-- 2) Backfill histórico con backup reversible -------------------------------
CREATE TABLE IF NOT EXISTS _backup_mov_fechas_20260612 AS
SELECT im.id, im.created_at
  FROM insumo_movimientos im
  JOIN factura_items fi ON fi.id::BIGINT = im.fuente_id
  JOIN facturas f ON f.id = fi.factura_id
 WHERE im.fuente_tipo = 'factura_item'
   AND im.deleted_at IS NULL
   AND f.fecha IS NOT NULL
   AND im.created_at::DATE <> f.fecha;

UPDATE insumo_movimientos im
   SET created_at = f.fecha::TIMESTAMPTZ
  FROM factura_items fi
  JOIN facturas f ON f.id = fi.factura_id
 WHERE im.fuente_tipo = 'factura_item'
   AND im.fuente_id = fi.id::BIGINT
   AND im.deleted_at IS NULL
   AND f.fecha IS NOT NULL
   AND im.created_at::DATE <> f.fecha;

REVOKE ALL ON _backup_mov_fechas_20260612 FROM authenticated, anon, PUBLIC;

COMMIT;
