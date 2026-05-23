-- ═══════════════════════════════════════════════════════════════════════════
-- FIX CRÍTICO: crear_gasto_empleado insertaba movimiento con importe POSITIVO
--
-- Bug descubierto 2026-05-23 con caso Maria Fernanda (Camilo, Neko Belgrano):
-- al cargar un adelanto desde Gastos → Empleado → Adelanto, la RPC creaba el
-- mov de caja con `importe = p_monto` (POSITIVO) cuando debía ser `-p_monto`
-- (NEGATIVO porque es un EGRESO de caja). Además el `tipo` quedaba con valor
-- 'egreso' (lowercase, no estándar) en lugar de 'Gasto empleado' (consistente
-- con la convención del resto del sistema).
--
-- Impacto: TODOS los adelantos cargados desde la pantalla Gastos (no los del
-- legajo RRHH) desde la migration 202605223400 (22-may) hasta hoy quedaron
-- con mov positivo. El cache de saldos_caja igual se descontó bien (porque
-- el UPDATE explícito de la línea 107-109 hace `saldo - p_monto`), pero la
-- SUMA visual de movimientos no coincide con el cache.
--
-- Adicional: la categoría del mov queda 'Adelanto' / 'Día doble' / etc.
-- (label). Para que sea consistente con la grilla de catálogo, queda como
-- está (estos labels ya están en config_categorias del grupo gasto_empleado).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crear_gasto_empleado(
  p_local_id INTEGER,
  p_empleado_id UUID,
  p_concepto TEXT,
  p_monto NUMERIC,
  p_cuenta TEXT,
  p_fecha DATE,
  p_detalle TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE (gasto_id TEXT, adelanto_id UUID)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_emp_local_id INTEGER;
  v_gasto_id TEXT;
  v_adelanto_id UUID;
  v_emp_nombre TEXT;
  v_concepto_label TEXT;
  v_cached jsonb;
  v_saldo_actual NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_concepto NOT IN ('adelanto','dia_doble','horas_extras','feriado','comida','viatico','otros') THEN
    RAISE EXCEPTION 'CONCEPTO_INVALIDO';
  END IF;
  IF p_cuenta IS NULL OR length(trim(p_cuenta)) = 0 THEN
    RAISE EXCEPTION 'CUENTA_REQUERIDA';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'crear_gasto_empleado' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN
      RETURN QUERY SELECT
        (v_cached->>'gasto_id')::TEXT,
        (v_cached->>'adelanto_id')::UUID;
      RETURN;
    END IF;
  END IF;

  SELECT local_id, nombre INTO v_emp_local_id, v_emp_nombre
    FROM rrhh_empleados
   WHERE id = p_empleado_id
     AND tenant_id = v_tenant_id
     AND COALESCE(activo, TRUE) = TRUE;
  IF v_emp_local_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  SELECT COALESCE(saldo, 0) INTO v_saldo_actual FROM saldos_caja
   WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;
  IF v_saldo_actual < p_monto THEN
    RAISE EXCEPTION 'SALDO_INSUFICIENTE';
  END IF;

  v_concepto_label := CASE p_concepto
    WHEN 'adelanto'     THEN 'Adelanto'
    WHEN 'dia_doble'    THEN 'Día doble'
    WHEN 'horas_extras' THEN 'Horas extra'
    WHEN 'feriado'      THEN 'Feriado'
    WHEN 'comida'       THEN 'Comida'
    WHEN 'viatico'      THEN 'Viático'
    WHEN 'otros'        THEN 'Otros'
  END;

  v_gasto_id := gen_random_uuid()::TEXT;
  INSERT INTO gastos (
    id, tenant_id, local_id, fecha, tipo, categoria, monto, detalle, cuenta, estado
  ) VALUES (
    v_gasto_id, v_tenant_id, p_local_id, p_fecha, 'empleado',
    v_concepto_label, p_monto,
    COALESCE(p_detalle, v_emp_nombre || ' — ' || v_concepto_label),
    p_cuenta, 'activo'
  );

  INSERT INTO rrhh_adelantos (
    tenant_id, empleado_id, fecha, monto, cuenta,
    descontado, concepto, gasto_id, registrado_por
  ) VALUES (
    v_tenant_id, p_empleado_id, p_fecha, p_monto, p_cuenta,
    FALSE, p_concepto, v_gasto_id, auth.uid()::text
  ) RETURNING id INTO v_adelanto_id;

  UPDATE saldos_caja SET
    saldo = saldo - p_monto
  WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;

  -- ─── FIX 23-may ─────────────────────────────────────────────────────
  -- Antes: importe = p_monto (POSITIVO), tipo = 'egreso' (lowercase).
  -- Ahora: importe = -p_monto (NEGATIVO, es EGRESO de caja),
  --        tipo = 'Gasto empleado' (consistente con resto del sistema).
  INSERT INTO movimientos (
    id, tenant_id, local_id, fecha, tipo, cat, importe, cuenta, detalle,
    gasto_id_ref, adelanto_id_ref, anulado
  ) VALUES (
    gen_random_uuid()::TEXT, v_tenant_id, p_local_id, p_fecha,
    'Gasto empleado', v_concepto_label, -p_monto, p_cuenta,
    v_emp_nombre || ' — ' || v_concepto_label,
    v_gasto_id, v_adelanto_id, FALSE
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES (
      'crear_gasto_empleado', p_idempotency_key, v_tenant_id,
      jsonb_build_object('gasto_id', v_gasto_id, 'adelanto_id', v_adelanto_id)
    )
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_gasto_id, v_adelanto_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
