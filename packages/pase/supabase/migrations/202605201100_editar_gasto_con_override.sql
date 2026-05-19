-- ═══════════════════════════════════════════════════════════════════════════
-- Editar gasto con Manager Override TOTP
--
-- Lucas 2026-05-19: igual que anular_gasto/factura/remito/movimiento,
-- editar_gasto debe poder ejecutarse por un encargado SIN permiso
-- compras_anular si el dueño le pasó un código TOTP válido.
--
-- DROP necesario porque cambia la signature (nuevo param opcional). Sin
-- drop, Postgres trata las 2 firmas como sobrecarga y PostgREST puede
-- resolver mal (incidente anular_movimiento 2026-05-18).
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS editar_gasto(text, date, text, text, numeric, text, text, text, text);

CREATE OR REPLACE FUNCTION editar_gasto(
  p_gasto_id        text,
  p_fecha           date,
  p_categoria       text,
  p_tipo            text,
  p_monto           numeric,
  p_cuenta          text,
  p_detalle         text,
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
  v_gasto RECORD;
  v_mov RECORD;
  v_cached jsonb;
  v_result jsonb;
  v_cambio_saldo boolean;
BEGIN
  -- Gate de auth: tiene permiso compras_anular O tiene código TOTP válido.
  -- auth_tiene_permiso_o_override loguea automáticamente el uso del override
  -- en la tabla manager_overrides_uso.
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'editar_gasto',
    jsonb_build_object(
      'gasto_id', p_gasto_id,
      'monto_nuevo', p_monto,
      'cuenta_nueva', p_cuenta,
      'motivo', p_justificativo
    )
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular o código del manager';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR trim(p_cuenta) = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR trim(p_categoria) = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;
  IF p_justificativo IS NULL OR trim(p_justificativo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'editar_gasto' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_gasto FROM gastos WHERE id = p_gasto_id FOR UPDATE;
  IF v_gasto IS NULL THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;
  IF v_gasto.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;
  IF v_gasto.estado = 'anulado' THEN RAISE EXCEPTION 'GASTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_gasto.local_id);

  SELECT * INTO v_mov FROM movimientos
    WHERE gasto_id_ref = p_gasto_id AND COALESCE(anulado, false) = false
    FOR UPDATE
    LIMIT 1;

  v_cambio_saldo := (v_gasto.cuenta IS DISTINCT FROM p_cuenta)
                 OR (v_gasto.monto IS DISTINCT FROM p_monto);

  IF v_mov.id IS NOT NULL AND v_cambio_saldo AND v_gasto.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_gasto.local_id, -COALESCE(v_mov.importe, 0));
    PERFORM _actualizar_saldo_caja(p_cuenta, v_gasto.local_id, -p_monto);
  END IF;

  UPDATE gastos
     SET fecha = p_fecha,
         categoria = p_categoria,
         tipo = p_tipo,
         monto = p_monto,
         cuenta = p_cuenta,
         detalle = p_detalle,
         editado = true,
         editado_motivo = p_justificativo,
         editado_at = now(),
         editado_por = v_usuario_id
   WHERE id = p_gasto_id;

  IF v_mov.id IS NOT NULL THEN
    UPDATE movimientos
       SET fecha = p_fecha,
           cuenta = p_cuenta,
           importe = -p_monto,
           cat = p_categoria,
           detalle = COALESCE(p_detalle, p_categoria),
           tipo = 'Gasto ' || COALESCE(p_tipo, ''),
           editado = true,
           editado_motivo = p_justificativo,
           editado_at = now()
     WHERE id = v_mov.id;
  END IF;

  PERFORM _auditar('gastos', 'EDICION', jsonb_build_object(
    'gasto_id', p_gasto_id,
    'antes', to_jsonb(v_gasto),
    'despues', jsonb_build_object(
      'fecha', p_fecha, 'categoria', p_categoria, 'tipo', p_tipo,
      'monto', p_monto, 'cuenta', p_cuenta, 'detalle', p_detalle
    ),
    'justificativo', p_justificativo,
    'mov_id', v_mov.id,
    'usuario_id', v_usuario_id,
    'editado_por_uid', v_caller_uid,
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  v_result := jsonb_build_object(
    'ok', true,
    'gasto_id', p_gasto_id,
    'mov_id', v_mov.id,
    'cambio_saldo', v_cambio_saldo
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('editar_gasto', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION editar_gasto(text, date, text, text, numeric, text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION editar_gasto(text, date, text, text, numeric, text, text, text, text, text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
