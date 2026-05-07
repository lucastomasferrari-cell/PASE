-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 7 — Sesión 2
--
-- Cierra BLOCKER #2 (IDOR), BLOCKER #3 (idempotency en RPCs comanda),
-- HIGH #1 (race condition en multi-pago) y HIGH #2 (manager override en
-- retiros >$5000).
--
-- Tablas tocadas:
--   - movimientos_caja: + idempotency_key TEXT + UNIQUE INDEX parcial.
--   - ventas_pos_overrides: + idempotency_key TEXT + UNIQUE INDEX parcial.
--
-- RPCs reescritas (mantienen firma + lógica original; agregan asserts +
-- idempotency check + locks donde aplica):
--   - fn_abrir_turno_caja_comanda
--   - fn_movimiento_caja_comanda (+ override en retiros >$5000)
--   - fn_anular_item_comanda
--   - fn_anular_venta_comanda
--   - fn_refund_venta_comanda
--   - fn_aplicar_descuento_comanda (versión final con idempotency)
--   - fn_cobrar_venta_comanda (idempotency a nivel header — los pagos ya
--     tenían idempotency_key UNIQUE individual)
--   - fn_agregar_pago_venta_comanda (HIGH #1: FOR UPDATE + check sobrepago)
--
-- Convención idempotency:
--   - Parámetro `p_idempotency_key TEXT DEFAULT NULL` (no breaking — call
--     sites legacy siguen funcionando, NULL salta el check).
--   - Si se pasa, SELECT previo busca registro existente con el key. Si
--     existe, retorna el ID original sin re-ejecutar.
--   - Si no se pasa, comportamiento legacy (riesgo de duplicado).
--   - El frontend post-sprint siempre lo pasa.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 0. Columnas + índices únicos ────────────────────────────────────────

ALTER TABLE movimientos_caja
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_caja_idempotency
  ON movimientos_caja(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE ventas_pos_overrides
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_pos_overrides_idempotency
  ON ventas_pos_overrides(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS cobro_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_pos_cobro_idempotency
  ON ventas_pos(cobro_idempotency_key)
  WHERE cobro_idempotency_key IS NOT NULL;

-- ─── 1. fn_abrir_turno_caja_comanda — IDOR + idempotency ─────────────────

CREATE OR REPLACE FUNCTION fn_abrir_turno_caja_comanda(
  p_local_id INTEGER,
  p_cajero_id UUID,
  p_monto_inicial NUMERIC,
  p_notas TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno_id BIGINT;
  v_numero INTEGER;
  v_existing_mov BIGINT;
BEGIN
  -- IDEMPOTENCY: si ya existe un movimiento de apertura con este key,
  -- retornamos el turno asociado.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT m.turno_caja_id INTO v_turno_id
    FROM movimientos_caja m
    WHERE m.idempotency_key = p_idempotency_key AND m.tipo = 'apertura';
    IF v_turno_id IS NOT NULL THEN RETURN v_turno_id; END IF;
  END IF;

  -- IDOR FIX (BLOCKER #2): validar local + cajero pertenecen al tenant.
  PERFORM fn_assert_local_autorizado(p_local_id);
  PERFORM fn_assert_empleado_en_local(p_cajero_id, p_local_id);

  IF NOT fn_check_perm_comanda('comanda.caja.abrir') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_ABRIR';
  END IF;

  IF EXISTS (SELECT 1 FROM turnos_caja WHERE local_id = p_local_id AND estado = 'abierto') THEN
    RAISE EXCEPTION 'TURNO_YA_ABIERTO: ya hay un turno abierto en este local';
  END IF;

  SELECT COALESCE(MAX(numero), 0) + 1 INTO v_numero
    FROM turnos_caja WHERE local_id = p_local_id;

  INSERT INTO turnos_caja (
    tenant_id, local_id, numero, cajero_id, monto_inicial, notas, estado
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_cajero_id, p_monto_inicial, p_notas, 'abierto'
  ) RETURNING id INTO v_turno_id;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_cajero_id, 'apertura',
    p_monto_inicial, 'efectivo', 'Apertura de turno', p_idempotency_key
  );
  RETURN v_turno_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_abrir_turno_caja_comanda(INTEGER, UUID, NUMERIC, TEXT, TEXT) TO authenticated;

-- ─── 2. fn_movimiento_caja_comanda — IDOR + idempotency + manager override ──
-- HIGH #2: retiros >$5000 ARS requieren PIN + motivo manager (>10 chars).
-- Constante v_umbral_override hardcoded; mover a comanda_local_settings es
-- deuda menor (DEUDA_TECNICA.md sprint 7).

CREATE OR REPLACE FUNCTION fn_movimiento_caja_comanda(
  p_local_id INTEGER,
  p_empleado_id UUID,
  p_tipo TEXT,
  p_monto NUMERIC,
  p_metodo TEXT,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL,
  p_manager_id UUID DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno_id BIGINT;
  v_mov_id BIGINT;
  v_existing_id BIGINT;
  v_umbral_override CONSTANT NUMERIC := 5000;
BEGIN
  -- IDEMPOTENCY check.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM movimientos_caja
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;
  END IF;

  -- IDOR FIX.
  PERFORM fn_assert_local_autorizado(p_local_id);
  PERFORM fn_assert_empleado_en_local(p_empleado_id, p_local_id);

  IF NOT fn_check_perm_comanda('comanda.caja.movimientos') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_MOVIMIENTOS';
  END IF;
  IF p_tipo NOT IN ('retiro','deposito','ajuste') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;

  -- HIGH #2: retiros grandes requieren manager override.
  IF p_tipo = 'retiro' AND ABS(p_monto) > v_umbral_override THEN
    IF p_manager_id IS NULL THEN
      RAISE EXCEPTION 'RETIRO_REQUIERE_MANAGER: retiros mayores a $% requieren autorización de manager', v_umbral_override;
    END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, p_local_id);
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
      WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'MANAGER_INVALIDO: el empleado % no es manager ni dueño', p_manager_id;
    END IF;
    IF p_motivo IS NULL OR LENGTH(TRIM(p_motivo)) < 10 THEN
      RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo debe tener al menos 10 caracteres para retiros > $%', v_umbral_override;
    END IF;
  END IF;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;
  IF v_turno_id IS NULL THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_empleado_id, p_tipo, p_monto, p_metodo, p_motivo,
    p_idempotency_key
  ) RETURNING id INTO v_mov_id;

  -- Audit override en ventas_pos_overrides si aplica.
  IF p_tipo = 'retiro' AND ABS(p_monto) > v_umbral_override AND p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id,
      accion, motivo, monto_afectado, idempotency_key
    ) VALUES (
      auth_tenant_id(), p_local_id, NULL, p_empleado_id, p_manager_id,
      'retiro_caja', p_motivo, ABS(p_monto),
      -- Key derivado para no chocar con el del movimiento.
      CASE WHEN p_idempotency_key IS NOT NULL
           THEN 'override_' || p_idempotency_key
           ELSE NULL END
    );
  END IF;

  RETURN v_mov_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_movimiento_caja_comanda(INTEGER, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, UUID) TO authenticated;

-- ─── 3. fn_anular_item_comanda — IDOR + idempotency ──────────────────────

CREATE OR REPLACE FUNCTION fn_anular_item_comanda(
  p_item_id BIGINT,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_subtotal NUMERIC;
  v_cajero UUID;
  v_existing BIGINT;
BEGIN
  -- IDEMPOTENCY: si ya hay override con este key, salir (efecto ya aplicado).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
  ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;

  SELECT venta_id, local_id, subtotal INTO v_venta_id, v_local_id, v_subtotal
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  -- IDOR FIX: validar manager pertenece al local de la venta.
  PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);

  SELECT cajero_id INTO v_cajero FROM ventas_pos WHERE id = v_venta_id;

  UPDATE ventas_pos_items SET
    estado = 'anulado', anulado_at = NOW(),
    anulado_motivo = p_motivo, updated_at = NOW()
  WHERE id = p_item_id;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, venta_item_id,
    cajero_id, manager_id, accion, motivo, monto_afectado, idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, v_venta_id, p_item_id,
    COALESCE(v_cajero, p_manager_id), p_manager_id, 'void', p_motivo, v_subtotal,
    p_idempotency_key
  );

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_anular_item_comanda(BIGINT, UUID, TEXT, TEXT) TO authenticated;

-- ─── 4. fn_aplicar_descuento_comanda — versión final con idempotency ────

CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda(
  p_venta_id BIGINT,
  p_monto NUMERIC,
  p_motivo TEXT,
  p_manager_id UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_subtotal NUMERIC;
  v_propina NUMERIC;
  v_local_id INTEGER;
  v_cajero UUID;
  v_pct NUMERIC;
  v_anterior NUMERIC;
  v_max_descuento NUMERIC;
  v_existing BIGINT;
BEGIN
  -- IDEMPOTENCY check vs override registrado con este key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT subtotal, COALESCE(propina, 0), local_id, cajero_id, descuento_total
    INTO v_subtotal, v_propina, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- IDOR FIX para manager (si se proporciona).
  IF p_manager_id IS NOT NULL THEN
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;

  -- Validaciones de monto (BLOCKER #1).
  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el monto debe ser >= 0';
  END IF;
  v_max_descuento := v_subtotal + v_propina;
  IF p_monto > v_max_descuento THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el descuento (%) supera el subtotal+propina (%)',
      p_monto, v_max_descuento;
  END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  IF v_pct > 15 THEN
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO_DESCUENTO_GRANDE'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
    ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;
  ELSE
    IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
    END IF;
  END IF;

  UPDATE ventas_pos SET
    descuento_total = p_monto, updated_at = NOW()
  WHERE id = p_venta_id;
  PERFORM fn_recalc_total_venta(p_venta_id);

  IF p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
      valor_anterior, valor_nuevo, monto_afectado, idempotency_key
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
      p_manager_id, 'discount', p_motivo, v_anterior, p_monto, p_monto,
      p_idempotency_key
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_aplicar_descuento_comanda(BIGINT, NUMERIC, TEXT, UUID, TEXT) TO authenticated;

-- ─── 5. fn_anular_venta_comanda — idempotency + IDOR ─────────────────────

CREATE OR REPLACE FUNCTION fn_anular_venta_comanda(
  p_venta_id BIGINT, p_manager_id UUID, p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_mesa_id BIGINT;
  v_cajero UUID;
  v_existing BIGINT;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
  ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;

  SELECT local_id, total, mesa_id, cajero_id
    INTO v_local_id, v_total, v_mesa_id, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);

  UPDATE ventas_pos SET estado = 'anulada', anulada_at = NOW(), updated_at = NOW()
   WHERE id = p_venta_id;
  UPDATE ventas_pos_items SET estado = 'anulado', anulado_at = NOW(), updated_at = NOW()
   WHERE venta_id = p_venta_id AND estado != 'anulado';
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
    p_manager_id, 'void', p_motivo, v_total, p_idempotency_key
  );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_anular_venta_comanda(BIGINT, UUID, TEXT, TEXT) TO authenticated;

-- ─── 6. fn_refund_venta_comanda — idempotency + IDOR ─────────────────────

CREATE OR REPLACE FUNCTION fn_refund_venta_comanda(
  p_venta_id BIGINT, p_manager_id UUID, p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_cajero UUID;
  v_existing BIGINT;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      SELECT total INTO v_total FROM ventas_pos WHERE id = p_venta_id;
      RETURN COALESCE(v_total, 0);
    END IF;
  END IF;

  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  SELECT local_id, total, cajero_id INTO v_local_id, v_total, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);

  UPDATE ventas_pos_pagos SET
    estado = 'reembolsado', reembolsado_at = NOW(), updated_at = NOW()
  WHERE venta_id = p_venta_id AND estado = 'confirmado';

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
    p_manager_id, 'refund', p_motivo, v_total, p_idempotency_key
  );
  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_refund_venta_comanda(BIGINT, UUID, TEXT, TEXT) TO authenticated;

-- ─── 7. fn_cobrar_venta_comanda — idempotency a nivel header ─────────────
-- Los pagos ya tienen idempotency_key UNIQUE individual a nivel ventas_pos_
-- pagos. Acá agregamos idempotency a nivel header (cobro completo) en
-- ventas_pos.cobro_idempotency_key para que doble-click del botón "Cobrar"
-- no intente re-procesar. Mantenemos toda la lógica original.

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
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  -- IDEMPOTENCY a nivel header.
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
  v_total := GREATEST(0, v_total);  -- Defense in depth (ver BLOCKER #1).

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_suma_pagos := v_suma_pagos + COALESCE((v_pago->>'monto')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_suma_pagos - v_total) > 0.01 THEN
    RAISE EXCEPTION 'SUMA_PAGOS_NO_COINCIDE: suma=% total=%', v_suma_pagos, v_total;
  END IF;

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

  IF v_turno_id IS NOT NULL THEN
    FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
      INSERT INTO movimientos_caja (
        tenant_id, local_id, turno_caja_id, empleado_id, tipo,
        monto, metodo, motivo, venta_id, idempotency_key
      ) VALUES (
        auth_tenant_id(), v_local_id, v_turno_id, COALESCE(p_cobrado_por,
          (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
        'venta', (v_pago->>'monto')::NUMERIC, v_pago->>'metodo',
        'Cobro venta #' || p_venta_id, p_venta_id,
        -- Key derivado por pago para idempotency.
        CASE WHEN v_pago->>'idempotency_key' IS NOT NULL
             THEN 'mov_' || (v_pago->>'idempotency_key')
             ELSE NULL END
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    END LOOP;
  END IF;

  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID, TEXT) TO authenticated;

-- ─── 8. fn_agregar_pago_venta_comanda — HIGH #1: FOR UPDATE + sobrepago ──

CREATE OR REPLACE FUNCTION fn_agregar_pago_venta_comanda(
  p_venta_id BIGINT,
  p_metodo TEXT,
  p_monto NUMERIC,
  p_idempotency_key TEXT,
  p_cobrado_por UUID DEFAULT NULL,
  p_vuelto NUMERIC DEFAULT NULL,
  p_propina_incluida NUMERIC DEFAULT 0
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_pago_id BIGINT;
  v_total_pagado NUMERIC;
  v_local_id INTEGER;
  v_turno_id BIGINT;
BEGIN
  -- Idempotency check.
  SELECT id INTO v_pago_id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key;
  IF v_pago_id IS NOT NULL THEN RETURN v_pago_id; END IF;

  -- HIGH #1: lock row para prevenir sobrepago bajo concurrencia con keys distintos.
  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta.estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_venta.estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  -- Calcular ya pagado (con lock activo).
  SELECT COALESCE(SUM(monto), 0) INTO v_total_pagado
    FROM ventas_pos_pagos
   WHERE venta_id = p_venta_id AND estado = 'confirmado';

  -- HIGH #1: rechazar sobrepago.
  IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN
    RAISE EXCEPTION 'SOBREPAGO: cobrarías % cuando faltan %',
      p_monto, GREATEST(0, v_venta.total - v_total_pagado)
      USING HINT = 'Race condition o input incorrecto';
  END IF;

  INSERT INTO ventas_pos_pagos (
    tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
    cobrado_por, vuelto, propina_incluida, estado, confirmado_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, p_metodo, p_monto, p_idempotency_key,
    COALESCE(p_cobrado_por, v_venta.cajero_id), p_vuelto, COALESCE(p_propina_incluida, 0),
    'confirmado', NOW()
  ) RETURNING id INTO v_pago_id;

  IF v_total_pagado + p_monto >= v_venta.total - 0.01 THEN
    UPDATE ventas_pos SET
      estado = 'cobrada',
      cobrada_at = NOW(),
      updated_at = NOW()
    WHERE id = p_venta_id;

    IF v_venta.mesa_id IS NOT NULL THEN
      UPDATE mesas SET estado = 'libre' WHERE id = v_venta.mesa_id;
    END IF;
  END IF;

  v_local_id := v_venta.local_id;
  v_turno_id := v_venta.turno_caja_id;
  IF v_turno_id IS NOT NULL THEN
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id, tipo,
      monto, metodo, motivo, venta_id, idempotency_key
    ) VALUES (
      v_venta.tenant_id, v_local_id, v_turno_id,
      COALESCE(p_cobrado_por, (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
      'venta', p_monto, p_metodo,
      'Cobro venta #' || p_venta_id, p_venta_id,
      'mov_' || p_idempotency_key
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_pago_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_agregar_pago_venta_comanda(BIGINT, TEXT, NUMERIC, TEXT, UUID, NUMERIC, NUMERIC) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN sesión 2 (sprint 7)
-- ═══════════════════════════════════════════════════════════════════════════
