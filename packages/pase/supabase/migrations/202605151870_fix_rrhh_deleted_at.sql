-- ═══════════════════════════════════════════════════════════════════════════
-- BUG FIX — referencias a rrhh_empleados.deleted_at (que no existe)
-- ═══════════════════════════════════════════════════════════════════════════
-- Error reportado: "column 'deleted_at' does not exist" al hacer ajuste/
-- depósito/retiro de caja.
--
-- Causa: en sprint 7 sesión 1 escribí `fn_assert_empleado_en_local` y en F1.6b
-- reescribí `fn_movimiento_caja_comanda` chequeando `rrhh_empleados.deleted_at
-- IS NULL`. Pero `rrhh_empleados` usa `activo BOOLEAN` para soft-delete,
-- no `deleted_at`. Las RPCs explotaban en runtime al planear la query.
--
-- Fix: reemplazar `deleted_at IS NULL` por `activo = TRUE` en todos los
-- helpers/RPCs que referencian rrhh_empleados.

-- ─── fn_assert_empleado_en_local ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_assert_empleado_en_local(p_empleado_id UUID, p_local_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth_es_superadmin() THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
    WHERE id = p_empleado_id
      AND local_id = p_local_id
      AND tenant_id = auth_tenant_id()
      AND activo = TRUE
  ) THEN
    RAISE EXCEPTION 'EMPLEADO_NO_EN_LOCAL: empleado % no pertenece al local %',
      p_empleado_id, p_local_id;
  END IF;
END;
$$;

-- ─── fn_movimiento_caja_comanda — manager check usa activo ───────────────
DROP FUNCTION IF EXISTS fn_movimiento_caja_comanda(INTEGER, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, UUID);

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
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM movimientos_caja
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;
  END IF;

  PERFORM fn_assert_local_autorizado(p_local_id);
  PERFORM fn_assert_empleado_en_local(p_empleado_id, p_local_id);

  IF NOT fn_check_perm_comanda('comanda.caja.movimientos') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_MOVIMIENTOS';
  END IF;
  IF p_tipo NOT IN ('retiro','deposito','ajuste') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;

  IF p_tipo = 'retiro' AND ABS(p_monto) > v_umbral_override THEN
    IF p_manager_id IS NULL THEN
      RAISE EXCEPTION 'RETIRO_REQUIERE_MANAGER: retiros mayores a $% requieren autorización de manager', v_umbral_override;
    END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, p_local_id);
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
      WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND activo = TRUE
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

  IF p_tipo = 'retiro' AND ABS(p_monto) > v_umbral_override AND p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id,
      accion, motivo, monto_afectado, idempotency_key
    ) VALUES (
      auth_tenant_id(), p_local_id, NULL, p_empleado_id, p_manager_id,
      'retiro_caja', p_motivo, ABS(p_monto),
      CASE WHEN p_idempotency_key IS NOT NULL
           THEN 'override_' || p_idempotency_key
           ELSE NULL END
    );
  END IF;

  RETURN v_mov_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_movimiento_caja_comanda(INTEGER, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, UUID) TO authenticated;
