-- ════════════════════════════════════════════════════════════════════════════
-- Autorizaciones de manager configurables por local (COMANDA)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Contexto: había 3 gates de autorización de manager hardcodeados que molestaban
-- (umbrales viejos, sin inflación):
--   1. Movimiento de caja/gasto >= $5000  → fn_movimiento_caja_comanda
--   2. Descuento > 15%                     → fn_aplicar_descuento_comanda
--   3. Cambiar precio de un item           → gate SOLO en frontend (VentaScreen)
--
-- Ahora son CONFIGURABLES por local vía comanda_local_settings, y arrancan
-- APAGADOS (default false) — Lucas: "lo quiero apagado por el momento".
-- La pantalla Configuración → Autorizaciones los prende/apaga y fija umbrales.
--
-- Fail-safe: si no hay fila de settings o el flag es false, NO se pide
-- autorización (comportamiento apagado). El umbral solo aplica si el flag está on.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS req_auth_movimiento        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS req_auth_movimiento_umbral numeric NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS req_auth_descuento         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS req_auth_descuento_pct     numeric NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS req_auth_cambio_precio      boolean NOT NULL DEFAULT false;

-- ─── movimiento de caja: umbral + on/off desde config ───────────────────────
CREATE OR REPLACE FUNCTION public.fn_movimiento_caja_comanda(p_local_id integer, p_empleado_id uuid, p_tipo text, p_monto numeric, p_metodo text, p_motivo text, p_idempotency_key text DEFAULT NULL::text, p_manager_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_turno_id BIGINT;
  v_mov_id BIGINT;
  v_existing_id BIGINT;
  v_req_auth BOOLEAN;
  v_umbral_override NUMERIC;
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

  -- Config de autorización por local (default OFF si no hay fila).
  SELECT COALESCE(req_auth_movimiento, false), COALESCE(req_auth_movimiento_umbral, 5000)
    INTO v_req_auth, v_umbral_override
    FROM comanda_local_settings
   WHERE local_id = p_local_id AND deleted_at IS NULL
   LIMIT 1;
  v_req_auth := COALESCE(v_req_auth, false);
  v_umbral_override := COALESCE(v_umbral_override, 5000);

  -- Gate de manager: solo si está activado en config Y supera el umbral.
  IF v_req_auth AND ABS(p_monto) >= v_umbral_override THEN
    IF p_manager_id IS NULL THEN
      RAISE EXCEPTION 'RETIRO_REQUIERE_MANAGER: movimientos de caja >= $% requieren autorización de manager', v_umbral_override;
    END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, p_local_id);
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
      WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND activo = TRUE
    ) THEN
      RAISE EXCEPTION 'MANAGER_INVALIDO: el empleado % no es manager ni dueño', p_manager_id;
    END IF;
    IF p_motivo IS NULL OR LENGTH(TRIM(p_motivo)) < 10 THEN
      RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo debe tener al menos 10 caracteres para movimientos de caja >= $%', v_umbral_override;
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

  -- Log de override solo si hubo autorización real de manager.
  IF v_req_auth AND ABS(p_monto) >= v_umbral_override AND p_manager_id IS NOT NULL THEN
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
$function$;

-- ─── descuento: umbral % + on/off desde config ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda(
  p_venta_id bigint,
  p_monto numeric,
  p_motivo text DEFAULT NULL,
  p_manager_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  v_req_auth BOOLEAN;
  v_pct_umbral NUMERIC;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT subtotal, COALESCE(propina, 0), local_id, cajero_id, descuento_total
    INTO v_subtotal, v_propina, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF p_manager_id IS NOT NULL THEN
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;

  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el monto debe ser >= 0';
  END IF;
  v_max_descuento := v_subtotal + v_propina;
  IF p_monto > v_max_descuento THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el descuento (%) supera el subtotal+propina (%)',
      p_monto, v_max_descuento;
  END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  -- Config de autorización por local (default OFF si no hay fila).
  SELECT COALESCE(req_auth_descuento, false), COALESCE(req_auth_descuento_pct, 15)
    INTO v_req_auth, v_pct_umbral
    FROM comanda_local_settings
   WHERE local_id = v_local_id AND deleted_at IS NULL
   LIMIT 1;
  v_req_auth := COALESCE(v_req_auth, false);
  v_pct_umbral := COALESCE(v_pct_umbral, 15);

  IF v_req_auth AND v_pct > v_pct_umbral THEN
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

  -- Descuento manual limpia el pct automático (se vuelve fijo).
  UPDATE ventas_pos SET
    descuento_total = p_monto,
    descuento_efectivo_pct = NULL,
    updated_at = NOW()
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
