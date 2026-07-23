-- B (COMANDA caja): que los medios "efectivo" que NO se llaman literalmente
-- 'efectivo' (ej. peya_efectivo, efectivo_delivery, efectivo_salon) cuenten
-- como PLATA FÍSICA en la caja / arqueo del turno.
--
-- Antes: el arqueo (fn_cerrar_turno_caja_comanda) y las pantallas de Caja
-- filtraban EXACTO `metodo = 'efectivo'`, así que un cobro con medio
-- 'peya_efectivo' quedaba fuera del efectivo en caja aunque ES plata física.
--
-- Modelo nuevo: bandera `medios_cobro.es_efectivo`. La caja usa esa bandera
-- (no el slug literal). Backfill desde la convención ya existente
-- (cuenta_destino = 'Caja Chica') + cualquier slug que contenga 'efectivo'.

-- 1. Columna nueva
ALTER TABLE public.medios_cobro
  ADD COLUMN IF NOT EXISTS es_efectivo boolean NOT NULL DEFAULT false;

-- 2. Backfill: son efectivo los que rutean a Caja Chica o tienen 'efectivo'
--    en el slug. (Neko: efectivo, efectivo_delivery, efectivo_salon, peya_efectivo.)
UPDATE public.medios_cobro
   SET es_efectivo = true
 WHERE deleted_at IS NULL
   AND (cuenta_destino = 'Caja Chica' OR slug ILIKE '%efectivo%');

-- 3. Arqueo del turno COMANDA: sumar el efectivo por la bandera, no por el slug.
--    (Único cambio vs la versión previa: el WHERE del cálculo de v_calculado.)
CREATE OR REPLACE FUNCTION public.fn_cerrar_turno_caja_comanda(
  p_turno_id bigint, p_cerrado_por uuid, p_monto_final_declarado numeric,
  p_notas text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text,
  p_efectivo_breakdown jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(monto_calculado numeric, diferencia numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Efectivo del turno = movimientos cuyo medio es_efectivo (ver medios_cobro).
  -- Un slug puede existir global (local_id NULL) y/o por local; con el IN sobre
  -- la lista de slugs efectivo del tenant alcanza (los duplicados no molestan).
  SELECT COALESCE(SUM(
    CASE
      -- 'venta_anulada' se guarda con monto NEGATIVO → suma plana (FIX 03-jul).
      WHEN tipo IN ('apertura','venta','deposito','ajuste','venta_anulada') THEN monto
      WHEN tipo IN ('retiro') THEN -monto
      ELSE 0
    END
  ), 0) INTO v_calculado
    FROM movimientos_caja
   WHERE turno_caja_id = p_turno_id
     AND metodo IN (
       SELECT slug FROM medios_cobro
        WHERE es_efectivo AND deleted_at IS NULL
          AND tenant_id = auth_tenant_id()
     );

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
$function$;
