-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 7 — Sesión 3
--
-- Cierra BLOCKER #3 (idempotency) en RPCs PASE de pagos atómicos:
--   - pagar_factura
--   - pagar_remito
--
-- Estas RPCs son las del paquete PASE (no comanda) que la auditoría 2026-
-- 05-07 marcó por riesgo de doble-pago. La sesión anterior hizo el saldo
-- proveedor a base de triggers (202605070900) — esta migration AGREGA el
-- check de idempotency manteniendo idéntica la lógica de saldo, audit y
-- movimiento_caja.
--
-- Tablas tocadas:
--   - movimientos: + idempotency_key TEXT + UNIQUE INDEX parcial.
--     (Independiente del idempotency_key de movimientos_caja de comanda.
--     Son tablas distintas: movimientos = caja PASE, movimientos_caja =
--     turnos POS comanda.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 0. Columna + índice ─────────────────────────────────────────────────

ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_idempotency
  ON movimientos(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ─── 1. pagar_factura — agregar idempotency_key ──────────────────────────
-- Mantiene firma + lógica idéntica a 202605070900:125-175. Solo:
--   - Agrega p_idempotency_key TEXT DEFAULT NULL.
--   - Si se pasa y ya existe un movimiento con ese key, retorna el resultado
--     previo (jsonb del movimiento existente) sin re-ejecutar.
--   - Persiste idempotency_key en movimientos.

CREATE OR REPLACE FUNCTION pagar_factura(
  p_factura_id text, p_monto numeric, p_cuenta text, p_fecha date,
  p_detalle text DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fac RECORD; v_nuevos_pagos jsonb; v_total_pagado numeric;
  v_nuevo_estado text; v_mov_id text; v_detalle text; v_tenant uuid;
  v_existing_mov RECORD;
BEGIN
  -- IDEMPOTENCY: si ya hay un movimiento con este key, retornar resultado
  -- previo sin re-ejecutar.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, fact_id INTO v_existing_mov FROM movimientos
    WHERE idempotency_key = p_idempotency_key
      AND tipo = 'Pago Proveedor'
      AND fact_id = p_factura_id;
    IF v_existing_mov.id IS NOT NULL THEN
      SELECT estado INTO v_nuevo_estado FROM facturas WHERE id = p_factura_id;
      RETURN jsonb_build_object(
        'mov_id', v_existing_mov.id,
        'nuevo_estado', v_nuevo_estado,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('cuenta', p_cuenta, 'monto', p_monto, 'fecha', p_fecha));
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;
  v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

  -- El UPDATE dispara trg_saldo_prov_facturas que recalcula proveedores.saldo.
  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos WHERE id = p_factura_id;

  IF v_fac.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_fac.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  v_detalle := COALESCE(p_detalle, 'Pago Fact ' || COALESCE(v_fac.nro, v_fac.id));
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle, fact_id, local_id, tenant_id,
    idempotency_key
  ) VALUES (
    v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_fac.cat,
    -p_monto, v_detalle, p_factura_id, v_fac.local_id, v_tenant,
    p_idempotency_key
  );

  PERFORM _auditar('facturas', 'PAGO', jsonb_build_object(
    'factura_id', p_factura_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado, 'total_pagado', v_total_pagado);
END;
$$;

-- ─── 2. pagar_remito — agregar idempotency_key ───────────────────────────

CREATE OR REPLACE FUNCTION pagar_remito(
  p_remito_id text, p_monto numeric, p_cuenta text, p_fecha date,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_r RECORD; v_prov RECORD; v_mov_id text; v_tenant uuid;
  v_existing_mov RECORD;
BEGIN
  -- IDEMPOTENCY check.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_mov FROM movimientos
    WHERE idempotency_key = p_idempotency_key
      AND tipo = 'Pago Proveedor'
      AND remito_id_ref = p_remito_id;
    IF v_existing_mov.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'mov_id', v_existing_mov.id,
        'nuevo_estado', 'pagado',
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_ANULADO'; END IF;
  IF v_r.estado = 'pagado' THEN RAISE EXCEPTION 'REMITO_YA_PAGADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  -- Trg_saldo_prov_remitos recalcula al cambiar estado a 'pagado'.
  UPDATE remitos SET estado = 'pagado' WHERE id = p_remito_id;

  SELECT * INTO v_prov FROM proveedores WHERE id = v_r.prov_id;

  IF v_r.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_r.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle, local_id, remito_id_ref, tenant_id,
    idempotency_key
  ) VALUES (
    v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_r.cat, -p_monto,
    'Pago remito ' || COALESCE(v_r.nro, v_r.id) || COALESCE(' - ' || v_prov.nombre, ''),
    v_r.local_id, p_remito_id, v_tenant,
    p_idempotency_key
  );

  PERFORM _auditar('remitos', 'PAGO', jsonb_build_object(
    'remito_id', p_remito_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', 'pagado');
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN sesión 3 (sprint 7)
-- ═══════════════════════════════════════════════════════════════════════════
