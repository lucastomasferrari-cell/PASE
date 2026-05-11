-- Fixes de BLOCKERs #1 (IDOR caja) y #2 (total negativo) del
-- AUDITORIA_TECNICA_2026-05-07 sobre COMANDA. Resuelvo solo los de bajo
-- riesgo y bien acotados.
--
-- BLOCKER #2 — fn_recalc_total_venta permite total negativo:
--   Si descuento_total > subtotal + propina, `total` queda < 0 y se
--   propaga al INSERT de movimiento_caja, EERR, conciliación.
--   Fix: floor con GREATEST(0, ...). Una sola línea.
--
-- BLOCKER #1 — IDOR en RPCs de caja COMANDA:
--   `fn_abrir_turno_caja_comanda` y `fn_movimiento_caja_comanda` aceptan
--   `p_local_id` + `p_cajero_id`/`p_empleado_id` sin validar que estén
--   entre los locales del caller ni que el empleado pertenezca al local.
--   Fix: validar al principio. Helper `_check_local_y_empleado_comanda`
--   reutilizable. Las otras 2 RPCs flageadas en el audit
--   (fn_anular_item_comanda, fn_aplicar_descuento_comanda) NO las toco
--   acá — usan `p_manager_id` (override) que tiene semántica distinta
--   (puede ser de otro local) y necesita análisis aparte.
--
-- Los otros 2 BLOCKERs (idempotency_key en RPCs de plata, storage UUID
-- prefix) son refactors mayores diferidos.

-- ─── Helper: validar local + empleado para el caller ─────────────────────
-- Acepta superadmin / dueno / admin de tenant. Para encargados/cajeros
-- valida que (a) `p_local_id` esté entre los locales asignados al caller
-- y (b) `p_empleado_id` (si se pasa) pertenezca a ese local en el tenant
-- del caller.
CREATE OR REPLACE FUNCTION _check_local_y_empleado_comanda(
  p_local_id INTEGER,
  p_empleado_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp_local INTEGER;
  v_emp_tenant uuid;
BEGIN
  -- Bypass para dueño/admin y superadmin (acceso total dentro del tenant).
  IF auth_es_superadmin() OR auth_es_dueno_o_admin() THEN
    -- Aún así validamos que el empleado, si se pasa, sea del mismo
    -- tenant — evita que un dueño de tenant A meta un empleado del
    -- tenant B en sus registros.
    IF p_empleado_id IS NOT NULL THEN
      SELECT local_id, tenant_id INTO v_emp_local, v_emp_tenant
        FROM rrhh_empleados WHERE id = p_empleado_id;
      IF v_emp_tenant IS NULL OR (NOT auth_es_superadmin() AND v_emp_tenant != auth_tenant_id()) THEN
        RAISE EXCEPTION 'EMPLEADO_NO_PERTENECE_A_TENANT';
      END IF;
      IF v_emp_local IS NOT NULL AND v_emp_local != p_local_id THEN
        RAISE EXCEPTION 'EMPLEADO_NO_PERTENECE_A_LOCAL';
      END IF;
    END IF;
    RETURN;
  END IF;

  -- Encargado/cajero: validar local autorizado.
  IF NOT (p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;

  -- Validar empleado pertenece a este local + mismo tenant.
  IF p_empleado_id IS NOT NULL THEN
    SELECT local_id, tenant_id INTO v_emp_local, v_emp_tenant
      FROM rrhh_empleados WHERE id = p_empleado_id;
    IF v_emp_tenant IS NULL OR v_emp_tenant != auth_tenant_id() THEN
      RAISE EXCEPTION 'EMPLEADO_NO_PERTENECE_A_TENANT';
    END IF;
    -- Si empleado tiene local_id NULL (manager regional, remoto), permitir.
    -- Solo bloquear si tiene un local concreto distinto al que se opera.
    IF v_emp_local IS NOT NULL AND v_emp_local != p_local_id THEN
      RAISE EXCEPTION 'EMPLEADO_NO_PERTENECE_A_LOCAL';
    END IF;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION _check_local_y_empleado_comanda(INTEGER, UUID) TO authenticated;

-- ─── BLOCKER #1a: fn_abrir_turno_caja_comanda ───────────────────────────
CREATE OR REPLACE FUNCTION fn_abrir_turno_caja_comanda(
  p_local_id INTEGER,
  p_cajero_id UUID,
  p_monto_inicial NUMERIC,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_turno_id BIGINT;
  v_numero INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.abrir') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_ABRIR';
  END IF;
  -- IDOR fix (BLOCKER #1): validar local autorizado + cajero pertenece al local
  PERFORM _check_local_y_empleado_comanda(p_local_id, p_cajero_id);

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
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_cajero_id, 'apertura', p_monto_inicial, 'efectivo', 'Apertura de turno'
  );
  RETURN v_turno_id;
END;
$$;

-- ─── BLOCKER #1b: fn_movimiento_caja_comanda ────────────────────────────
CREATE OR REPLACE FUNCTION fn_movimiento_caja_comanda(
  p_local_id INTEGER,
  p_empleado_id UUID,
  p_tipo TEXT,
  p_monto NUMERIC,
  p_metodo TEXT,
  p_motivo TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_turno_id BIGINT;
  v_mov_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.movimientos') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_MOVIMIENTOS';
  END IF;
  -- IDOR fix (BLOCKER #1): validar local autorizado + empleado pertenece al local
  PERFORM _check_local_y_empleado_comanda(p_local_id, p_empleado_id);

  IF p_tipo NOT IN ('retiro','deposito','ajuste') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;
  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;
  IF v_turno_id IS NULL THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;
  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_empleado_id, p_tipo, p_monto, p_metodo, p_motivo
  ) RETURNING id INTO v_mov_id;
  RETURN v_mov_id;
END;
$$;

-- ─── BLOCKER #2: fn_recalc_total_venta ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_recalc_total_venta(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_subtotal NUMERIC;
BEGIN
  SELECT COALESCE(SUM(subtotal - descuento), 0) INTO v_subtotal
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';
  UPDATE ventas_pos SET
    subtotal = v_subtotal,
    -- Floor en 0: si descuento_total > subtotal + propina, no permitimos
    -- que el total sea negativo (audit 2026-05-07 sección 2.1). La
    -- validación principal debería estar también en
    -- fn_aplicar_descuento_comanda, pero este floor previene el efecto
    -- contable downstream.
    total = GREATEST(0, v_subtotal - descuento_total + propina),
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$$;
