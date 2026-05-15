-- ═══════════════════════════════════════════════════════════════════════════
-- Cash Management — fn_cerrar_turno_caja_comanda con breakdown opcional
-- ═══════════════════════════════════════════════════════════════════════════
-- Extiende la RPC con un parámetro nuevo p_efectivo_breakdown JSONB para
-- evitar UPDATE directo en turnos_caja desde el frontend (regla C4
-- enforced por ESLint pase-local/no-direct-financiera-write).
--
-- Compatible: el parámetro es DEFAULT NULL, los callers sin breakdown
-- (modo rápido) no necesitan pasarlo y el comportamiento es idéntico.

-- DROP versión vieja (4 args) para no dejar overload con la nueva (5 args).
DROP FUNCTION IF EXISTS fn_cerrar_turno_caja_comanda(BIGINT, UUID, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION fn_cerrar_turno_caja_comanda(
  p_turno_id BIGINT,
  p_cerrado_por UUID,
  p_monto_final_declarado NUMERIC,
  p_notas TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_efectivo_breakdown JSONB DEFAULT NULL
) RETURNS TABLE(
  monto_calculado NUMERIC,
  diferencia NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calculado NUMERIC;
  v_local_id INTEGER;
  v_estado_actual TEXT;
  v_existing_monto_calc NUMERIC;
  v_existing_monto_decl NUMERIC;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.cerrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_CERRAR';
  END IF;

  -- F1.6 idempotency.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT monto_final_calculado, monto_final_declarado, estado
      INTO v_existing_monto_calc, v_existing_monto_decl, v_estado_actual
      FROM turnos_caja
     WHERE id = p_turno_id AND cerrar_idempotency_key = p_idempotency_key;
    IF v_existing_monto_calc IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_monto_calc, v_existing_monto_decl - v_existing_monto_calc;
      RETURN;
    END IF;
  END IF;

  SELECT local_id, estado INTO v_local_id, v_estado_actual
    FROM turnos_caja WHERE id = p_turno_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'TURNO_NO_ENCONTRADO'; END IF;
  IF v_estado_actual = 'cerrado' THEN RAISE EXCEPTION 'TURNO_YA_CERRADO'; END IF;

  PERFORM fn_assert_local_autorizado(v_local_id);

  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('apertura','venta','deposito','ajuste') THEN monto
      WHEN tipo IN ('retiro','venta_anulada') THEN -monto
      ELSE 0
    END
  ), 0) INTO v_calculado
    FROM movimientos_caja
   WHERE turno_caja_id = p_turno_id AND metodo = 'efectivo';

  UPDATE turnos_caja SET
    estado = 'cerrado',
    cerrado_at = NOW(),
    cerrado_por = p_cerrado_por,
    monto_final_declarado = p_monto_final_declarado,
    monto_final_calculado = v_calculado,
    diferencia = p_monto_final_declarado - v_calculado,
    notas = COALESCE(notas, '') || COALESCE(E'\n--cierre--\n' || p_notas, ''),
    cerrar_idempotency_key = p_idempotency_key,
    -- Cash Management: persistir breakdown si vino.
    efectivo_breakdown = COALESCE(p_efectivo_breakdown, efectivo_breakdown)
  WHERE id = p_turno_id;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_turno_id, p_cerrado_por, 'cierre',
    p_monto_final_declarado, 'efectivo', 'Cierre de turno (declarado)',
    CASE WHEN p_idempotency_key IS NOT NULL
         THEN 'cierre_turno_' || p_idempotency_key
         ELSE NULL
    END
  );

  RETURN QUERY SELECT v_calculado, p_monto_final_declarado - v_calculado;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cerrar_turno_caja_comanda(BIGINT, UUID, NUMERIC, TEXT, TEXT, JSONB) TO authenticated;

COMMENT ON FUNCTION fn_cerrar_turno_caja_comanda(BIGINT, UUID, NUMERIC, TEXT, TEXT, JSONB) IS
  'Cierra turno de caja. F1.6 idempotency. Cash Management: persiste breakdown por denominaciones si viene en p_efectivo_breakdown.';
