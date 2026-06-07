-- ─────────────────────────────────────────────────────────────────────────
-- crear_gasto_empleado: TODOS los conceptos quedan como "YA PAGADO" tildable
-- ─────────────────────────────────────────────────────────────────────────
--
-- Pedido Lucas 07-jun: cuando se carga un gasto a un empleado (Cargar Gasto →
-- Tipo Empleados → cualquier concepto: adelanto, día doble, horas extra,
-- feriado, comida, viático, otros), esa plata YA salió de la caja y ya se le
-- dio al empleado. Tiene que quedar REGISTRADA en la card del sueldo (sección
-- que ahora se llama "YA PAGADO") con un tilde, para que al pagar la quincena
-- uno pueda descontarla manualmente de lo que le paga (no pagar dos veces).
--
-- ANTES (fix 25-may, bug Bernal): solo concepto='adelanto' insertaba en
-- rrhh_adelantos; los demás conceptos solo registraban gasto + mov de caja y
-- NO aparecían en ningún lado del sueldo → no se podían descontar.
--
-- El bug Bernal original era que esos registros se DESCONTABAN SOLOS del sueldo
-- (auto-aplicar). Eso ya no pasa desde 31-may: los registros de rrhh_adelantos
-- NUNCA se pre-tildan, el dueño los tilda manualmente. Por eso ahora es seguro
-- volver a registrar TODOS los conceptos: aparecen en "YA PAGADO" pero no se
-- descuentan hasta que alguien los tilde. Además se muestra el `concepto` de
-- cada uno (Comida / Horas extra / etc.) así se entiende qué es cada registro
-- (la confusión de Anto en el caso Bernal era justamente que no se sabía qué
-- era ese "adelanto" fantasma).
--
-- Único cambio respecto de la versión vigente (202605270700): el bloque
-- `IF p_concepto = 'adelanto' THEN INSERT ... ELSE NULL` pasa a insertar SIEMPRE
-- en rrhh_adelantos (con descontado=FALSE), para cualquier concepto válido.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crear_gasto_empleado(p_local_id integer, p_empleado_id uuid, p_concepto text, p_monto numeric, p_cuenta text, p_fecha date, p_detalle text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS TABLE(gasto_id text, adelanto_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_id UUID;
  v_emp_local_id INTEGER;
  v_gasto_id TEXT;
  v_adelanto_id UUID;
  v_emp_nombre TEXT;
  v_concepto_label TEXT;
  v_cached JSONB;
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

  -- AUDIT FIX #8: filtro por tenant en idempotency lookup.
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'crear_gasto_empleado' AND key = p_idempotency_key AND tenant_id = v_tenant_id;
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

  -- CAMBIO 07-jun (Lucas): SIEMPRE registrar en rrhh_adelantos, sea cual sea el
  -- concepto. Queda como saldo "YA PAGADO" del empleado, descontado=FALSE → no
  -- se aplica solo, el dueño lo tilda manualmente al pagar la quincena. El
  -- `concepto` se guarda y se muestra en la card para que se entienda qué es.
  INSERT INTO rrhh_adelantos (
    tenant_id, empleado_id, fecha, monto, cuenta,
    descontado, concepto, gasto_id, registrado_por
  ) VALUES (
    v_tenant_id, p_empleado_id, p_fecha, p_monto, p_cuenta,
    FALSE, p_concepto, v_gasto_id, auth.uid()::text
  ) RETURNING id INTO v_adelanto_id;

  -- AUDIT FIX #15: eliminado UPDATE saldos_caja manual.
  -- El trigger trg_sync_saldos_caja recalcula al ver el INSERT siguiente.

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
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_gasto_id, v_adelanto_id;
END;
$function$;

COMMENT ON FUNCTION public.crear_gasto_empleado IS
  'Crea gasto a empleado + movimiento de caja + registro en rrhh_adelantos '
  '(descontado=FALSE) para CUALQUIER concepto. Cambio 07-jun: todos los '
  'conceptos quedan como "YA PAGADO" tildable en la card del sueldo (antes solo '
  '''adelanto''). No se descuentan solos — el dueño los tilda al pagar.';
