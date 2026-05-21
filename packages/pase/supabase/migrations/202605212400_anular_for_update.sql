-- ═══════════════════════════════════════════════════════════════════════════
-- ALTO-11 Auditoría 2026-05-21: anular_remito + anular_gasto con FOR UPDATE
--
-- En el sprint críticos (CRIT-7) agregamos FOR UPDATE a anular_factura
-- pero faltaba anular_remito y anular_gasto. Mismo bug: race condition
-- con pagar/anular simultáneos puede dejar inconsistencias.
--
-- Mientras tanto aprovecho y valido también p_motivo/permisos al inicio.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION anular_remito(
  p_remito_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_r RECORD; v_tenant uuid;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_remito',
    jsonb_build_object('remito_id', p_remito_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  -- ALTO-11 FIX: lock del remito.
  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id FOR UPDATE;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  UPDATE remitos SET estado = 'anulado' WHERE id = p_remito_id;

  PERFORM _auditar('remitos', 'ANULACION', jsonb_build_object(
    'remito_id', p_remito_id, 'motivo', p_motivo,
    'estado_previo', v_r.estado, 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('remito_id', p_remito_id, 'estado', 'anulado');
END;
$$;

CREATE OR REPLACE FUNCTION anular_gasto(
  p_gasto_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_gasto RECORD;
  v_mov RECORD;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_gasto',
    jsonb_build_object('gasto_id', p_gasto_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_motivo IS NULL OR trim(p_motivo) = '' THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  -- ALTO-11 FIX: lock del gasto.
  SELECT * INTO v_gasto FROM gastos WHERE id = p_gasto_id FOR UPDATE;
  IF v_gasto IS NULL THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;
  IF COALESCE(v_gasto.estado, 'activo') = 'anulado' THEN
    RAISE EXCEPTION 'GASTO_YA_ANULADO';
  END IF;

  PERFORM _validar_local_autorizado(v_gasto.local_id);

  UPDATE gastos
    SET estado = 'anulado',
        anulado_motivo = p_motivo,
        anulado_at = NOW(),
        anulado_por = v_usuario_id
    WHERE id = p_gasto_id;

  -- ALTO-11 FIX: lock del movimiento asociado.
  SELECT * INTO v_mov FROM movimientos
    WHERE gasto_id_ref = p_gasto_id AND anulado = FALSE
    FOR UPDATE;
  IF v_mov.id IS NOT NULL THEN
    UPDATE movimientos
      SET anulado = TRUE, anulado_motivo = 'Anulación del gasto: ' || p_motivo
      WHERE id = v_mov.id;
    IF v_mov.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
    END IF;
  END IF;

  PERFORM _auditar('gastos', 'ANULACION', jsonb_build_object(
    'gasto_id', p_gasto_id, 'motivo', p_motivo,
    'usuario_id', v_usuario_id,
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('gasto_id', p_gasto_id, 'estado', 'anulado', 'caller_uid', v_caller_uid);
END;
$$;

NOTIFY pgrst, 'reload schema';
