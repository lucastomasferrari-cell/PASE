-- ═══════════════════════════════════════════════════════════════════════════
-- Feature 1: Gastos con tipo "empleado" — pago anticipado al momento + impacto
-- en novedades RRHH para que se descuente del sueldo final.
--
-- Caso de uso (Lucas): pagás un día doble el día 5 a un empleado. La plata
-- sale de caja HOY. Cuando se liquide el sueldo a fin de mes, ese pago ya
-- realizado tiene que descontarse del total.
--
-- Modelo elegido:
--   - Extender CHECK gastos.tipo con 'empleado'.
--   - Extender rrhh_adelantos con `concepto` (default 'adelanto' para back-compat).
--   - Cualquier "rrhh_adelantos" (sea adelanto, día doble pagado, horas extra
--     pagadas, etc.) se descuenta del sueldo en pagar_sueldo() — ya lo hacía
--     para el concepto 'adelanto', ahora también para los nuevos.
--   - Cada `rrhh_adelantos` puede linkearse a un `gasto_id` cuando se cargó
--     desde el módulo Gastos. Reportes pueden filtrar por concepto.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extender CHECK de gastos.tipo ─────────────────────────────────────
ALTER TABLE gastos DROP CONSTRAINT IF EXISTS gastos_tipo_check;
ALTER TABLE gastos ADD CONSTRAINT gastos_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'fijo'::text, 'variable'::text, 'publicidad'::text,
    'comision'::text, 'impuesto'::text, 'retiro_socio'::text,
    'empleado'::text  -- nuevo: pago anticipado a empleado (día doble, horas extra, adelanto, etc.)
  ]));

-- ─── 2. rrhh_adelantos: nueva columna `concepto` + `gasto_id` ─────────────
ALTER TABLE rrhh_adelantos
  ADD COLUMN IF NOT EXISTS concepto TEXT NOT NULL DEFAULT 'adelanto'
    CHECK (concepto IN (
      'adelanto',           -- adelanto tradicional (default, back-compat)
      'dia_doble',          -- pago de día doble al instante
      'horas_extras',       -- pago de horas extras al instante
      'feriado',            -- pago de feriado trabajado
      'comida',             -- vale comida / refrigerio
      'viatico',            -- viáticos varios
      'otros'               -- otros descuentos arbitrarios
    )),
  ADD COLUMN IF NOT EXISTS gasto_id TEXT REFERENCES gastos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_adelantos_concepto
  ON rrhh_adelantos(empleado_id, concepto, descontado)
  WHERE descontado = FALSE;

CREATE INDEX IF NOT EXISTS idx_adelantos_gasto
  ON rrhh_adelantos(gasto_id) WHERE gasto_id IS NOT NULL;

COMMENT ON COLUMN rrhh_adelantos.concepto IS
  'Tipo de pago anticipado. ''adelanto'' = adelanto tradicional. Otros = pagos puntuales (día doble, horas extra, feriado, etc.) que se descuentan del sueldo final.';
COMMENT ON COLUMN rrhh_adelantos.gasto_id IS
  'Si se cargó desde módulo Gastos (tipo=empleado), referencia al gasto. NULL si se cargó directo desde RRHH.';

-- ─── 3. RPC: crear_gasto_empleado (atómico: gasto + adelanto + caja) ─────
--
-- Crea el gasto en EERR + registra el pago anticipado en rrhh_adelantos +
-- descuenta de caja. Llamado desde Gastos.tsx cuando el usuario selecciona
-- tipo=empleado.
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

  -- Validaciones
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

  -- Validar empleado + local
  SELECT local_id, nombre INTO v_emp_local_id, v_emp_nombre
    FROM rrhh_empleados
   WHERE id = p_empleado_id
     AND tenant_id = v_tenant_id
     AND COALESCE(activo, TRUE) = TRUE;
  IF v_emp_local_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  -- Permisos: el operador debe ver el local del gasto Y el local del empleado.
  -- (Si el empleado es "compartido" con varios locales, Feature 2 va a
  -- relajar esto — por ahora el local del gasto debe matchear con el
  -- empleado o ser visible para el usuario.)
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Validar saldo disponible en la cuenta
  SELECT COALESCE(saldo, 0) INTO v_saldo_actual FROM saldos_caja
   WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;
  IF v_saldo_actual < p_monto THEN
    RAISE EXCEPTION 'SALDO_INSUFICIENTE';
  END IF;

  -- Label legible para el concepto (para el detalle del gasto)
  v_concepto_label := CASE p_concepto
    WHEN 'adelanto'     THEN 'Adelanto'
    WHEN 'dia_doble'    THEN 'Día doble'
    WHEN 'horas_extras' THEN 'Horas extra'
    WHEN 'feriado'      THEN 'Feriado'
    WHEN 'comida'       THEN 'Comida'
    WHEN 'viatico'      THEN 'Viático'
    WHEN 'otros'        THEN 'Otros'
  END;

  -- 1. INSERT gasto. gastos.id es TEXT autogenerado (uuid::text).
  v_gasto_id := gen_random_uuid()::TEXT;
  INSERT INTO gastos (
    id, tenant_id, local_id, fecha, tipo, categoria, monto, detalle, cuenta, estado
  ) VALUES (
    v_gasto_id, v_tenant_id, p_local_id, p_fecha, 'empleado',
    v_concepto_label, p_monto,
    COALESCE(p_detalle, v_emp_nombre || ' — ' || v_concepto_label),
    p_cuenta, 'activo'
  );

  -- 2. INSERT rrhh_adelantos con concepto + gasto_id (se descuenta del sueldo)
  INSERT INTO rrhh_adelantos (
    tenant_id, empleado_id, fecha, monto, cuenta,
    descontado, concepto, gasto_id, registrado_por
  ) VALUES (
    v_tenant_id, p_empleado_id, p_fecha, p_monto, p_cuenta,
    FALSE, p_concepto, v_gasto_id, auth.uid()::text
  ) RETURNING id INTO v_adelanto_id;

  -- 3. UPDATE saldos_caja (descontar)
  UPDATE saldos_caja SET
    saldo = saldo - p_monto,
    updated_at = NOW()
  WHERE local_id = p_local_id AND cuenta = p_cuenta AND tenant_id = v_tenant_id;

  -- 4. INSERT movimientos (auditoría). Usamos gasto_id_ref + adelanto_id_ref
  -- como link al gasto y al adelanto. Generamos id text único.
  INSERT INTO movimientos (
    id, tenant_id, local_id, fecha, tipo, cat, importe, cuenta, detalle,
    gasto_id_ref, adelanto_id_ref, anulado
  ) VALUES (
    gen_random_uuid()::TEXT, v_tenant_id, p_local_id, p_fecha,
    'egreso', v_concepto_label, p_monto, p_cuenta,
    v_emp_nombre || ' — ' || v_concepto_label || ' (anticipo)',
    v_gasto_id, v_adelanto_id, FALSE
  );

  -- Cachear idempotency
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

GRANT EXECUTE ON FUNCTION crear_gasto_empleado(INTEGER, UUID, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT) TO authenticated;

-- ─── 4. Vista: desglose de adelantos por concepto y mes ───────────────────
-- Para que la pantalla de liquidación pueda mostrar "Ya pagado en el mes:
-- 2 días dobles ($X), 3 horas extras ($Y), etc."
CREATE OR REPLACE VIEW v_rrhh_adelantos_desglose AS
SELECT
  a.tenant_id,
  a.empleado_id,
  EXTRACT(YEAR FROM a.fecha)::INTEGER AS anio,
  EXTRACT(MONTH FROM a.fecha)::INTEGER AS mes,
  a.concepto,
  COUNT(*) FILTER (WHERE NOT a.descontado) AS cantidad_pendiente,
  COALESCE(SUM(a.monto) FILTER (WHERE NOT a.descontado), 0) AS monto_pendiente,
  COUNT(*) AS cantidad_total,
  COALESCE(SUM(a.monto), 0) AS monto_total
FROM rrhh_adelantos a
GROUP BY a.tenant_id, a.empleado_id, EXTRACT(YEAR FROM a.fecha), EXTRACT(MONTH FROM a.fecha), a.concepto;

GRANT SELECT ON v_rrhh_adelantos_desglose TO authenticated;

NOTIFY pgrst, 'reload schema';
