-- ═══════════════════════════════════════════════════════════════════════════
-- F1.1c — Lock costo CMV al cobrar la venta
-- ═══════════════════════════════════════════════════════════════════════════
-- Cierra la última pata floja del CMV: al cobrar una venta, snapshotear la
-- receta viva de cada item en `recetas_versiones` y guardar el version_id en
-- `ventas_pos_items.receta_version_id`. Si la receta cambia después, la venta
-- ya cobrada queda atada a la versión histórica → costo CMV reproducible.
--
-- Decisiones:
--   - El snapshot es BEST-EFFORT: si fn_snapshot_receta_a_version() levanta
--     error por cualquier motivo, el cobro NO se bloquea (la venta sigue).
--     El item queda con receta_version_id=NULL y se loguea via NOTICE.
--   - Idempotente: si ya hay version con mismo contenido para ese item,
--     fn_snapshot_receta_a_version la reusa (no duplica).
--   - Items sin receta: receta_version_id queda NULL (la fn ya retorna NULL).

-- ─── 1. Columna en ventas_pos_items ──────────────────────────────────────
ALTER TABLE ventas_pos_items
  ADD COLUMN IF NOT EXISTS receta_version_id BIGINT NULL
    REFERENCES recetas_versiones(id);

COMMENT ON COLUMN ventas_pos_items.receta_version_id IS
  'F1.1c: snapshot inmutable de la receta vigente al momento del cobro. NULL si el item no tiene receta o el snapshot falló (ver fn_cobrar_venta_comanda).';

CREATE INDEX IF NOT EXISTS idx_vpi_receta_version
  ON ventas_pos_items(receta_version_id)
  WHERE receta_version_id IS NOT NULL;

-- ─── 2. Reescribir fn_cobrar_venta_comanda con snapshot por item ──────────
-- Misma firma, misma lógica de cobro. Agrega un loop antes del UPDATE final
-- que llama fn_snapshot_receta_a_version() por cada item de la venta. Si
-- falla, se ignora silenciosamente (RAISE NOTICE) y el cobro continúa.

CREATE OR REPLACE FUNCTION fn_cobrar_venta_comanda(
  p_venta_id BIGINT,
  p_pagos JSONB,
  p_propina NUMERIC DEFAULT 0,
  p_cobrado_por UUID DEFAULT NULL
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_total NUMERIC;
  v_suma_pagos NUMERIC := 0;
  v_pago JSONB;
  v_turno_id BIGINT;
  v_mesa_id BIGINT;
  v_item RECORD;
  v_version_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, estado, subtotal, descuento_total, turno_caja_id, mesa_id
    INTO v_local_id, v_estado, v_subtotal, v_descuento, v_turno_id, v_mesa_id
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  v_total := v_subtotal - v_descuento + COALESCE(p_propina, 0);

  -- Validar suma == total
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_suma_pagos := v_suma_pagos + COALESCE((v_pago->>'monto')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_suma_pagos - v_total) > 0.01 THEN
    RAISE EXCEPTION 'SUMA_PAGOS_NO_COINCIDE: suma=% total=%', v_suma_pagos, v_total;
  END IF;

  -- Insertar pagos (idempotency_key UNIQUE atómico)
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO ventas_pos_pagos (
      tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
      vuelto, propina_incluida, cobrado_por, estado, confirmado_at
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id,
      v_pago->>'metodo',
      (v_pago->>'monto')::NUMERIC,
      v_pago->>'idempotency_key',
      NULLIF((v_pago->>'vuelto'),'')::NUMERIC,
      COALESCE((v_pago->>'propina_incluida')::NUMERIC, 0),
      p_cobrado_por,
      'confirmado',
      NOW()
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  -- F1.1c: snapshot de receta por item (best-effort, no bloquea cobro).
  -- Iteramos ítems activos (no anulados) y para cada uno llamamos a la RPC
  -- de snapshot. Si la receta no existe o falla, queda NULL.
  FOR v_item IN
    SELECT id, item_id FROM ventas_pos_items
    WHERE venta_id = p_venta_id
      AND deleted_at IS NULL
      AND estado <> 'anulado'
      AND receta_version_id IS NULL  -- idempotente: no re-snapshotear
  LOOP
    BEGIN
      v_version_id := fn_snapshot_receta_a_version(v_item.item_id);
      IF v_version_id IS NOT NULL THEN
        UPDATE ventas_pos_items
          SET receta_version_id = v_version_id
          WHERE id = v_item.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Silente: snapshot es best-effort, el cobro no debe bloquearse.
      RAISE NOTICE 'F1.1c snapshot falló item_id=%, venta_id=%: %',
        v_item.item_id, p_venta_id, SQLERRM;
    END;
  END LOOP;

  -- Actualizar venta
  UPDATE ventas_pos SET
    estado = 'cobrada', propina = COALESCE(p_propina, 0),
    cobrada_at = NOW(),
    total = v_total,
    updated_at = NOW()
  WHERE id = p_venta_id;

  -- Liberar mesa
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Movimiento de caja por pago (1 por método)
  IF v_turno_id IS NOT NULL THEN
    FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
      INSERT INTO movimientos_caja (
        tenant_id, local_id, turno_caja_id, empleado_id, tipo,
        monto, metodo, motivo, venta_id
      ) VALUES (
        auth_tenant_id(), v_local_id, v_turno_id, COALESCE(p_cobrado_por,
          (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
        'venta', (v_pago->>'monto')::NUMERIC, v_pago->>'metodo',
        'Cobro venta #' || p_venta_id, p_venta_id
      );
    END LOOP;
  END IF;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID) IS
  'Cobra venta multi-pago idempotente. F1.1c: además snapshotea receta viva en cada item (best-effort) para lock de costo CMV.';
