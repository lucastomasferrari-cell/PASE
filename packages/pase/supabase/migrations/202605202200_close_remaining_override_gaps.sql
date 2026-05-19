-- ═══════════════════════════════════════════════════════════════════════════
-- Cierre de gaps de override TOTP (2026-05-19, sesión cierre Caja+Compras+Ventas)
--
-- 1. Drop firmas viejas duplicadas de anular_factura / anular_remito (sin
--    p_override_code). PostgREST se confunde con overload (mismo bug que
--    pasó con anular_gasto el 19-may).
-- 2. editar_movimiento_caja: acepta p_override_code + chequea
--    auth_tiene_permiso_o_override('caja_anular', ...). Antes era solo
--    auth_es_dueno_o_admin() — un encargado nunca podía editar aunque
--    tuviera código del dueño.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Drop firmas duplicadas viejas ────────────────────────────────────
DROP FUNCTION IF EXISTS anular_factura(text, text);
DROP FUNCTION IF EXISTS anular_remito(text, text);

-- ─── 2. editar_movimiento_caja con override ───────────────────────────────
DROP FUNCTION IF EXISTS editar_movimiento_caja(text, date, text, text, numeric, text, text, text, text);

CREATE OR REPLACE FUNCTION editar_movimiento_caja(
  p_mov_id          text,
  p_fecha           date,
  p_detalle         text,
  p_cat             text,
  p_importe         numeric,
  p_cuenta          text,
  p_tipo            text,
  p_justificativo   text,
  p_idempotency_key text DEFAULT NULL,
  p_override_code   text DEFAULT NULL
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
  -- ─── 1) Auth: permiso caja_anular O código TOTP válido ──────────────────
  IF NOT auth_tiene_permiso_o_override(
    'caja_anular',
    p_override_code,
    'editar_movimiento_caja',
    jsonb_build_object(
      'mov_id', p_mov_id,
      'importe_nuevo', p_importe,
      'cuenta_nueva', p_cuenta,
      'motivo', p_justificativo
    )
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso caja_anular o código del manager';
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

  -- ─── 4) Cargar original + lock ───────────────────────────────────────────
  SELECT * INTO v_orig FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_orig IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_orig.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;
  IF v_orig.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_orig.local_id);

  -- ─── 5) Ajuste de saldos si cambió cuenta o importe ──────────────────────
  v_cambio_saldo := (v_orig.cuenta IS DISTINCT FROM p_cuenta)
                 OR (v_orig.importe IS DISTINCT FROM p_importe);

  IF v_cambio_saldo AND v_orig.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_orig.cuenta, v_orig.local_id, -COALESCE(v_orig.importe, 0));
    PERFORM _actualizar_saldo_caja(p_cuenta, v_orig.local_id, p_importe);
  END IF;

  -- ─── 6) Update del movimiento ────────────────────────────────────────────
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

  -- ─── 7) Auditoria ────────────────────────────────────────────────────────
  PERFORM _auditar('movimientos', 'EDICION', jsonb_build_object(
    'mov_id', p_mov_id,
    'antes', to_jsonb(v_orig),
    'despues', jsonb_build_object(
      'fecha', p_fecha, 'detalle', p_detalle, 'cat', p_cat,
      'importe', p_importe, 'cuenta', p_cuenta, 'tipo', p_tipo
    ),
    'justificativo', p_justificativo,
    'cambio_saldo', v_cambio_saldo,
    'usuario_id', v_usuario_id,
    'editado_por_uid', v_caller_uid,
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

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

GRANT EXECUTE ON FUNCTION editar_movimiento_caja(text, date, text, text, numeric, text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION editar_movimiento_caja(text, date, text, text, numeric, text, text, text, text, text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
