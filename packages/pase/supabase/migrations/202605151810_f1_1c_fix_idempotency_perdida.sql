-- ═══════════════════════════════════════════════════════════════════════════
-- F1.1c FIX — Restaurar idempotency en fn_cobrar_venta_comanda
-- ═══════════════════════════════════════════════════════════════════════════
-- BUG: en F1.1c (migration 202605151750) reescribí fn_cobrar_venta_comanda
-- con la firma vieja de 4 args, sin darme cuenta que en el repo existe
-- también `202605091210_sprint7_idor_idempotency_comanda.sql` que la había
-- elevado a 5 args con p_idempotency_key. Como el frontend de COMANDA
-- (packages/comanda/src/services/pagosService.ts) llama la RPC pasando
-- p_idempotency_key, mi cambio dejaba el cobro de venta roto:
--   "function fn_cobrar_venta_comanda(bigint, jsonb, numeric, uuid, text) does not exist"
--
-- VERIFICACIÓN del estado real en prod (2026-05-15):
--   - `ventas_pos.cobro_idempotency_key` NO existía (sprint 7 nunca aplicado).
--   - Solo había 1 versión de la fn con 4 args (la mía).
--   - Sprint 7 hizo varios cambios más (otras RPCs, otras columnas idempotency)
--     que TAMPOCO están en prod — eso es deuda preexistente, NO la toca esta
--     migration. Está documentada en project_tareas_manuales_pendientes.md.
--
-- ESTA MIGRATION hace lo mínimo para destrabar fn_cobrar_venta_comanda:
--   1. Agrega columna ventas_pos.cobro_idempotency_key + UNIQUE INDEX parcial.
--   2. Dropea la versión 4-args (la mía rota).
--   3. Crea la versión 5-args combinando sprint 7 (idempotency a nivel header)
--      + F1.1c (snapshot best-effort de receta por item).
--
-- Aplicada en prod inmediatamente después del commit (procedimiento estándar).

-- ─── 1. Columna + índice único parcial ────────────────────────────────────
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS cobro_idempotency_key TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_pos_cobro_idempotency
  ON ventas_pos(cobro_idempotency_key)
  WHERE cobro_idempotency_key IS NOT NULL;

COMMENT ON COLUMN ventas_pos.cobro_idempotency_key IS
  'Sprint 7: idempotency a nivel header del cobro (doble-click "Cobrar" en POS). UNIQUE parcial — re-cobro con misma key retorna total sin reprocesar.';

-- ─── 2. Drop versión 4-args (la introducida por F1.1c original) ──────────
DROP FUNCTION IF EXISTS fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID);

-- ─── 3. Versión 5-args = sprint 7 + F1.1c combinados ──────────────────────
CREATE OR REPLACE FUNCTION fn_cobrar_venta_comanda(
  p_venta_id BIGINT,
  p_pagos JSONB,
  p_propina NUMERIC DEFAULT 0,
  p_cobrado_por UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
  v_total NUMERIC;
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_suma_pagos NUMERIC := 0;
  v_pago JSONB;
  v_turno_id BIGINT;
  v_mesa_id BIGINT;
  v_existing_key TEXT;
  v_item RECORD;
  v_version_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  -- IDEMPOTENCY a nivel header (sprint 7).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT cobro_idempotency_key, total INTO v_existing_key, v_total
    FROM ventas_pos WHERE id = p_venta_id;
    IF v_existing_key = p_idempotency_key THEN
      RETURN COALESCE(v_total, 0);
    END IF;
  END IF;

  SELECT local_id, estado, subtotal, descuento_total, turno_caja_id, mesa_id
    INTO v_local_id, v_estado, v_subtotal, v_descuento, v_turno_id, v_mesa_id
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  v_total := v_subtotal - v_descuento + COALESCE(p_propina, 0);
  v_total := GREATEST(0, v_total);  -- Defense in depth (sprint 7 BLOCKER #1).

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_suma_pagos := v_suma_pagos + COALESCE((v_pago->>'monto')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_suma_pagos - v_total) > 0.01 THEN
    RAISE EXCEPTION 'SUMA_PAGOS_NO_COINCIDE: suma=% total=%', v_suma_pagos, v_total;
  END IF;

  -- Insertar pagos (idempotency_key UNIQUE a nivel pago — sprint 7).
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
  FOR v_item IN
    SELECT id, item_id FROM ventas_pos_items
    WHERE venta_id = p_venta_id
      AND deleted_at IS NULL
      AND estado <> 'anulado'
      AND receta_version_id IS NULL
  LOOP
    BEGIN
      v_version_id := fn_snapshot_receta_a_version(v_item.item_id);
      IF v_version_id IS NOT NULL THEN
        UPDATE ventas_pos_items
          SET receta_version_id = v_version_id
          WHERE id = v_item.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'F1.1c snapshot falló item_id=%, venta_id=%: %',
        v_item.item_id, p_venta_id, SQLERRM;
    END;
  END LOOP;

  UPDATE ventas_pos SET
    estado = 'cobrada', propina = COALESCE(p_propina, 0),
    cobrada_at = NOW(),
    total = v_total,
    cobro_idempotency_key = COALESCE(p_idempotency_key, cobro_idempotency_key),
    updated_at = NOW()
  WHERE id = p_venta_id;

  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Movimiento caja con idempotency_key derivado (sprint 7).
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

GRANT EXECUTE ON FUNCTION fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID, TEXT) IS
  'Cobra venta multi-pago. Sprint 7: idempotency a nivel header via cobro_idempotency_key. F1.1c: snapshotea receta viva de cada item (best-effort) para lock de costo CMV.';
