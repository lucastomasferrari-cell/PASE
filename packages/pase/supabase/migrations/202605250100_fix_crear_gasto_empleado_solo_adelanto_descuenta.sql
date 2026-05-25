-- ─────────────────────────────────────────────────────────────────────────
-- Fix crear_gasto_empleado: solo concepto='adelanto' descuenta del sueldo
-- ─────────────────────────────────────────────────────────────────────────
--
-- Bug descubierto 25-may por Anto: cargó un "Gasto a empleado" para BERNAL
-- RUEDA con concepto='otros' detalle='quincena cubrio caja' por $425k. El
-- sistema lo registró como ADELANTO en rrhh_adelantos → en la próxima
-- liquidación intentaba descontar -$425k del sueldo. Anto no entendía por
-- qué aparecía un adelanto que ella nunca cargó como tal.
--
-- Root cause: la RPC `crear_gasto_empleado` SIEMPRE inserta en
-- rrhh_adelantos sin importar el concepto. Los conceptos válidos son:
-- adelanto, dia_doble, horas_extras, feriado, comida, viatico, otros.
-- Pero solo 'adelanto' es semánticamente un descuento futuro del sueldo;
-- los demás son beneficios/pagos accesorios que ya se cobraron en el
-- momento (comida, viático) o son partes del sueldo del mes (horas extras,
-- día doble, feriado) que se cargan en el INPUT de novedades aparte.
--
-- Fix: solo crear el registro en rrhh_adelantos cuando concepto='adelanto'.
-- Para los otros conceptos, solo registrar el gasto + movimiento de caja
-- (la plata efectivamente salió de la caja en el momento, pero NO se
-- descuenta del próximo sueldo).
--
-- Impacto operativo:
-- - Hoy: 1 falso positivo en producción (Bernal — fixeado a mano).
-- - Futuro: cualquier "Gasto a empleado" con concepto != 'adelanto' ya
--   no va a generar adelanto fantasma.
--
-- Si Lucas quiere que ALGUNOS otros conceptos también descuenten (p.ej.
-- horas_extras que ya se pagaron en efectivo en el mes), eso es decisión
-- de producto a discutir aparte — por ahora, regla conservadora: solo
-- 'adelanto' descuenta.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crear_gasto_empleado(
  p_local_id INTEGER,
  p_empleado_id UUID,
  p_concepto TEXT,
  p_monto NUMERIC,
  p_cuenta TEXT,
  p_fecha DATE,
  p_detalle TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE(gasto_id TEXT, adelanto_id UUID)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_emp_local_id INTEGER;
  v_gasto_id TEXT;
  v_adelanto_id UUID;
  v_emp_nombre TEXT;
  v_concepto_label TEXT;
  v_cached JSONB;
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

  -- FIX 2026-05-25: SOLO crear adelanto si concepto='adelanto'. Los demás
  -- conceptos (comida, viático, día doble, etc.) son gastos que el empleado
  -- ya cobró en el momento y NO se descuentan del próximo sueldo.
  -- Antes: cualquier concepto creaba un adelanto fantasma que en la
  -- liquidación siguiente intentaba descontar del sueldo (bug Bernal Rueda).
  IF p_concepto = 'adelanto' THEN
    INSERT INTO rrhh_adelantos (
      tenant_id, empleado_id, fecha, monto, cuenta,
      descontado, concepto, gasto_id, registrado_por
    ) VALUES (
      v_tenant_id, p_empleado_id, p_fecha, p_monto, p_cuenta,
      FALSE, p_concepto, v_gasto_id, auth.uid()::text
    ) RETURNING id INTO v_adelanto_id;
  ELSE
    v_adelanto_id := NULL;  -- gasto sin adelanto asociado
  END IF;

  UPDATE saldos_caja SET
    saldo = saldo - p_monto
  WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;

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

COMMENT ON FUNCTION public.crear_gasto_empleado IS
  'Crea gasto a empleado + movimiento de caja. Fix 2026-05-25: solo crea '
  'registro en rrhh_adelantos cuando concepto=''adelanto'' (los demás son '
  'beneficios/pagos accesorios que no se descuentan del próximo sueldo). '
  'Antes: cualquier concepto creaba adelanto fantasma → bug Bernal Rueda.';
