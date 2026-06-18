-- 202606182000_concil_mp_multifactura_no_duplicar.sql
-- BUG plata: fn_conciliar_mp_con_facturas creaba SIEMPRE un movimiento de pago
-- + descontaba el saldo, aun cuando las facturas YA estaban pagadas (flujo real
-- de Lucas: paga la factura individual primero y DESPUÉS concilia). Eso duplicaba
-- el egreso => saldo de MercadoPago descontado de más (21 movs, ~$9.88M).
-- Fix: acumula v_total_nuevo = SOLO lo no-ya-pagado; crea el mov y descuenta el
-- saldo unicamente por esa parte. Si todo ya estaba pagado (v_total_nuevo=0) la
-- conciliacion SOLO vincula (tabla puente + justificativo), sin mov ni saldo.
-- (Limpieza de los 21 duplicados existentes = paso aparte, con OK de Lucas.)

CREATE OR REPLACE FUNCTION public.fn_conciliar_mp_con_facturas(p_mp_mov_id text, p_lineas jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp                RECORD;
  v_usuario_id        integer;
  v_linea             jsonb;
  v_factura_id        text;
  v_monto             numeric;
  v_fac               RECORD;
  v_proveedor_id      integer;
  v_proveedor_primero integer;
  v_nuevos_pagos      jsonb;
  v_total_pagado      numeric;
  v_nuevo_estado      text;
  v_total_aplicado    numeric := 0;
  v_facturas_pagadas  text[] := ARRAY[]::text[];
  v_mov_id            text;
  v_cached            jsonb;
  v_result            jsonb;
  v_monto_abs         numeric;
  v_fecha             date;
  v_estaba_pagada     boolean;
  v_nros              text[] := ARRAY[]::text[];
  v_total_nuevo       numeric := 0;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  IF p_lineas IS NULL OR jsonb_typeof(p_lineas) != 'array' OR jsonb_array_length(p_lineas) = 0 THEN
    RAISE EXCEPTION 'LINEAS_REQUERIDAS';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'fn_conciliar_mp_con_facturas' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);

  IF EXISTS (SELECT 1 FROM mp_movimientos WHERE id = p_mp_mov_id AND ignorado = true) THEN
    RAISE EXCEPTION 'MP_MOV_IGNORADO';
  END IF;

  v_monto_abs := abs(v_mp.monto);
  v_fecha     := COALESCE((v_mp.fecha)::date, current_date);

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_factura_id := nullif(trim(v_linea->>'factura_id'), '');
    v_monto      := COALESCE((v_linea->>'monto_aplicado')::numeric, 0);
    IF v_factura_id IS NULL THEN RAISE EXCEPTION 'FACTURA_ID_REQUERIDO'; END IF;
    IF v_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

    SELECT * INTO v_fac FROM facturas WHERE id = v_factura_id FOR UPDATE;
    IF v_fac IS NULL                       THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
    IF v_fac.tenant_id <> v_mp.tenant_id   THEN RAISE EXCEPTION 'FACTURA_CROSS_TENANT';  END IF;
    IF v_fac.estado = 'anulada'            THEN RAISE EXCEPTION 'FACTURA_ANULADA';       END IF;
    -- Antes acá había `IF v_fac.estado = 'pagada' THEN RAISE 'FACTURA_YA_PAGADA'`.
    -- Removido a propósito (decisión Lucas 2026-05-12): permitir conciliar
    -- egresos MP retroactivamente contra facturas ya pagadas. Ver lógica
    -- condicional más abajo (v_estaba_pagada).
    v_estaba_pagada := v_fac.estado = 'pagada';

    v_proveedor_id := v_fac.prov_id;
    IF v_proveedor_primero IS NULL THEN
      v_proveedor_primero := v_proveedor_id;
    ELSIF v_proveedor_id IS DISTINCT FROM v_proveedor_primero THEN
      RAISE EXCEPTION 'FACTURAS_DE_PROVEEDORES_DISTINTOS';
    END IF;

    -- Junta el N° de cada factura para un detalle legible (Lucas 18-jun).
    v_nros := array_append(v_nros, COALESCE(NULLIF(trim(v_fac.nro), ''), v_factura_id));

    -- Solo modificamos pagos/estado/saldo si la factura NO estaba pagada.
    -- Si ya lo estaba, registramos en la tabla puente pero no duplicamos
    -- el pago (evita sobrepago) ni decrementamos el saldo (ya se descontó).
    IF NOT v_estaba_pagada THEN
      v_total_nuevo := v_total_nuevo + v_monto;
      v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'cuenta', 'MercadoPago',
          'monto',  v_monto,
          'fecha',  v_fecha,
          'mp_mov_id', p_mp_mov_id
        )
      );
      SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
        FROM jsonb_array_elements(v_nuevos_pagos) e;
      v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

      UPDATE facturas
         SET estado = v_nuevo_estado,
             pagos  = v_nuevos_pagos
       WHERE id = v_factura_id;

      IF v_fac.prov_id IS NOT NULL THEN
        UPDATE proveedores
           SET saldo = GREATEST(0, COALESCE(saldo, 0) - v_monto)
         WHERE id = v_fac.prov_id;
      END IF;

      IF v_nuevo_estado = 'pagada' THEN
        v_facturas_pagadas := array_append(v_facturas_pagadas, v_factura_id);
      END IF;
    END IF;

    -- Tabla puente siempre se popula (rastro auditable).
    INSERT INTO mp_movimiento_facturas (mp_mov_id, factura_id, monto_aplicado, tenant_id)
      VALUES (p_mp_mov_id, v_factura_id, v_monto, v_mp.tenant_id);

    v_total_aplicado := v_total_aplicado + v_monto;
  END LOOP;

  -- Solo crea el movimiento de pago (y descuenta saldo) por la parte que NO
  -- estaba ya pagada. Si todas las facturas ya tenían su pago individual
  -- (v_total_nuevo = 0), la conciliación SOLO vincula (puente + justificativo),
  -- sin duplicar el egreso ni volver a descontar MercadoPago.
  -- (Lucas 18-jun: antes creaba el mov siempre => doble carga del saldo.)
  IF v_total_nuevo > 0 THEN
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
      VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Multi-factura',
              'PAGO_PROVEEDOR', -v_total_nuevo,
              'Pago ' || COALESCE((SELECT nombre FROM proveedores WHERE id = v_proveedor_primero), 'proveedor') || ' - Fact ' || array_to_string(v_nros, ', ') || ' (vía MP)',
              v_mp.local_id, v_mp.tenant_id, NULL);
    PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_total_nuevo);
  END IF;

  UPDATE mp_movimientos
     SET justificativo_tipo = 'multi_factura',
         justificativo_id   = NULL,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_MULTI_FACTURA', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'mov_id', v_mov_id,
    'cant_facturas', jsonb_array_length(p_lineas),
    'total_aplicado', v_total_aplicado, 'monto_mp', v_monto_abs,
    'diferencia', v_monto_abs - v_total_aplicado,
    'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  v_result := jsonb_build_object(
    'mp_mov_id', p_mp_mov_id,
    'tipo', 'multi_factura',
    'mov_id', v_mov_id,
    'total_aplicado', v_total_aplicado,
    'monto_mp', v_monto_abs,
    'diferencia', v_monto_abs - v_total_aplicado,
    'facturas_pagadas', to_jsonb(v_facturas_pagadas)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('fn_conciliar_mp_con_facturas', p_idempotency_key, v_mp.tenant_id, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$
;

NOTIFY pgrst, 'reload schema';
