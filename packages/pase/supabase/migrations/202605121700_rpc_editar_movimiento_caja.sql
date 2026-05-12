-- ═══════════════════════════════════════════════════════════════════════════
-- RPC editar_movimiento_caja: editar un movimiento + ajustar saldos atómico.
--
-- Cumple deuda C4-F11. Antes (Caja.tsx:342-393) se hacían 4 operaciones
-- separadas: SELECT saldo viejo + UPDATE -X cuenta vieja + SELECT saldo nuevo
-- + UPDATE +X cuenta nueva + UPDATE movimiento + INSERT auditoria. Si
-- cualquiera fallaba a mitad (network glitch, deadlock, RLS revocada),
-- quedaba la DB inconsistente (ej: Caja Chica -$100 y Banco sin cambios →
-- $100 desaparecidos del libro contable).
--
-- Esta RPC hace TODO en una sola transacción usando el helper existente
-- _actualizar_saldo_caja (mismo patrón que crear_cierre_ventas).
--
-- SECURITY DEFINER + auth_es_dueno_o_admin (regla C11) — editar movimientos
-- es operación admin-only por diseño actual (no encargados).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION editar_movimiento_caja(
  p_mov_id          text,
  p_fecha           date,
  p_detalle         text,
  p_cat             text,
  p_importe         numeric,
  p_cuenta          text,
  p_tipo            text,
  p_justificativo   text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_orig RECORD;
  v_cached jsonb;
  v_result jsonb;
  v_cambio_saldo boolean;
BEGIN
  -- ─── 1) Auth (regla C11) ─────────────────────────────────────────────────
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede editar movimientos';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  -- ─── 2) Validar input ────────────────────────────────────────────────────
  IF p_mov_id IS NULL OR length(trim(p_mov_id)) = 0 THEN
    RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO';
  END IF;
  IF p_justificativo IS NULL OR length(trim(p_justificativo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;
  IF p_cuenta IS NULL OR length(trim(p_cuenta)) = 0 THEN
    RAISE EXCEPTION 'CUENTA_INVALIDA';
  END IF;

  -- ─── 3) Idempotency check ────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'editar_movimiento_caja' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  -- ─── 4) Lock del movimiento + validaciones de tenant/anulado ────────────
  SELECT * INTO v_orig FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_orig IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_orig.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;
  IF COALESCE(v_orig.anulado, false) THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  -- ─── 5) Ajustar saldos si cambió cuenta o importe ────────────────────────
  -- Usa _actualizar_saldo_caja(cuenta, local_id, delta, permitir_negativo).
  -- El cuarto arg true permite saldos negativos transitoriamente (ej. al
  -- revertir uno grande antes de aplicar el nuevo).
  v_cambio_saldo := (v_orig.cuenta IS DISTINCT FROM p_cuenta)
                 OR (v_orig.importe IS DISTINCT FROM p_importe);

  IF v_cambio_saldo AND v_orig.local_id IS NOT NULL THEN
    -- Revertir el efecto del movimiento viejo en su cuenta vieja.
    PERFORM _actualizar_saldo_caja(v_orig.cuenta, v_orig.local_id, -COALESCE(v_orig.importe, 0), true);
    -- Aplicar el efecto nuevo en la cuenta nueva.
    PERFORM _actualizar_saldo_caja(p_cuenta, v_orig.local_id, COALESCE(p_importe, 0), true);
  END IF;

  -- ─── 6) Actualizar el movimiento ─────────────────────────────────────────
  UPDATE movimientos
     SET fecha = p_fecha,
         detalle = p_detalle,
         cat = p_cat,
         importe = p_importe,
         cuenta = p_cuenta,
         tipo = p_tipo,
         editado = true,
         editado_motivo = p_justificativo,
         editado_at = now()
   WHERE id = p_mov_id;

  -- ─── 7) Auditoría ────────────────────────────────────────────────────────
  INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
  VALUES ('movimientos', 'EDICION',
    jsonb_build_object(
      'id', p_mov_id,
      'antes', to_jsonb(v_orig),
      'despues', jsonb_build_object(
        'fecha', p_fecha, 'detalle', p_detalle, 'cat', p_cat,
        'importe', p_importe, 'cuenta', p_cuenta, 'tipo', p_tipo
      ),
      'justificativo', p_justificativo,
      'usuario_id', v_usuario_id,
      'editado_por_uid', v_caller_uid
    )::text,
    now(),
    v_tenant
  );

  v_result := jsonb_build_object(
    'ok', true,
    'mov_id', p_mov_id,
    'cambio_saldo', v_cambio_saldo
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('editar_movimiento_caja', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION editar_movimiento_caja(text, date, text, text, numeric, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION editar_movimiento_caja(text, date, text, text, numeric, text, text, text, text) FROM PUBLIC;
