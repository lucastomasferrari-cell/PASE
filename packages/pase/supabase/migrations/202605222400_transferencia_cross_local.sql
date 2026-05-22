-- ═══════════════════════════════════════════════════════════════════════════
-- Transferir entre cuentas de DISTINTOS LOCALES
--
-- Pedido Lucas 22-may noche: hoy transferencia_cuentas solo permite mover
-- plata entre 2 cuentas del MISMO local. Pero hay casos legítimos de
-- transferir entre locales (ej: Villa Crespo Caja Efectivo → Belgrano Caja
-- Efectivo cuando se reparte sobrante físico de caja, o MercadoPago global
-- que se asigna a un local específico).
--
-- Cambio: nuevo parámetro p_local_destino_id (default NULL = same-local,
-- mantiene backward compat con frontend viejo). Si viene seteado y es
-- distinto del p_local_id, genera la transferencia cross-local con:
--   - Egreso en (cuenta_origen, local_origen)
--   - Ingreso en (cuenta_destino, local_destino)
--   - Mismo transferencia_id linkea ambos
--   - Validación de permisos sobre AMBOS locales
--   - Validación de mismo tenant (no cross-tenant)
--
-- Edge case: si origen=destino local Y origen=destino cuenta → error
-- CUENTAS_IGUALES. Pero ahora "misma cuenta distinto local" SÍ se permite
-- (caso: mover Caja Efectivo física entre sucursales).
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop la versión vieja (6 args sin p_local_destino_id). PostgreSQL trata
-- la firma como distinta porque cambiamos el número de parámetros — sin
-- el DROP quedaríamos con 2 versiones de transferencia_cuentas y supabase
-- podría confundirse al elegir cuál llamar via RPC.
DROP FUNCTION IF EXISTS transferencia_cuentas(integer, text, text, numeric, date, text);

CREATE OR REPLACE FUNCTION transferencia_cuentas(
  p_local_id integer,
  p_cuenta_origen text,
  p_cuenta_destino text,
  p_monto numeric,
  p_fecha date,
  p_detalle text DEFAULT NULL,
  p_local_destino_id integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov_out text; v_mov_in text; v_detalle text;
  v_transf_id uuid := gen_random_uuid(); v_tenant uuid;
  v_tenant_destino uuid;
  v_local_dst integer;
  v_cross_local boolean;
  v_nombre_origen text;
  v_nombre_destino text;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta_origen IS NULL OR p_cuenta_origen = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_cuenta_destino IS NULL OR p_cuenta_destino = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUERIDO'; END IF;

  -- Resolver local destino: si NULL, asume same-local (backward compat).
  v_local_dst := COALESCE(p_local_destino_id, p_local_id);
  v_cross_local := (v_local_dst <> p_local_id);

  -- Si es same-local Y mismas cuentas → error (no tiene sentido).
  IF NOT v_cross_local AND p_cuenta_origen = p_cuenta_destino THEN
    RAISE EXCEPTION 'CUENTAS_IGUALES';
  END IF;

  -- Validar permisos sobre AMBOS locales.
  PERFORM _validar_local_autorizado(p_local_id);
  IF v_cross_local THEN
    PERFORM _validar_local_autorizado(v_local_dst);
  END IF;

  -- Tenant origen (y validar destino same-tenant).
  SELECT tenant_id, nombre INTO v_tenant, v_nombre_origen FROM locales WHERE id = p_local_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO'; END IF;

  IF v_cross_local THEN
    SELECT tenant_id, nombre INTO v_tenant_destino, v_nombre_destino FROM locales WHERE id = v_local_dst;
    IF v_tenant_destino IS NULL THEN RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO'; END IF;
    IF v_tenant_destino <> v_tenant THEN
      RAISE EXCEPTION 'TENANT_MISMATCH';
    END IF;
  ELSE
    v_nombre_destino := v_nombre_origen;
  END IF;

  -- Detalle: si cross-local incluir nombres; si same-local mantener formato viejo.
  IF p_detalle IS NOT NULL AND p_detalle <> '' THEN
    v_detalle := p_detalle;
  ELSIF v_cross_local THEN
    v_detalle := 'Transferencia ' || v_nombre_origen || ' (' || p_cuenta_origen || ') → '
              || v_nombre_destino || ' (' || p_cuenta_destino || ')';
  ELSE
    v_detalle := 'Transferencia ' || p_cuenta_origen || ' → ' || p_cuenta_destino;
  END IF;

  -- Ajustar saldos en ambas cuentas/locales.
  PERFORM _actualizar_saldo_caja(p_cuenta_origen, p_local_id, -p_monto);
  PERFORM _actualizar_saldo_caja(p_cuenta_destino, v_local_dst, p_monto);

  -- Movimiento de salida (en el local origen).
  v_mov_out := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id, tenant_id)
  VALUES (v_mov_out, p_fecha, p_cuenta_origen, 'Transferencia Salida', NULL,
    -p_monto, v_detalle, p_local_id, v_transf_id, v_tenant);

  -- Movimiento de entrada (en el local destino — puede ser distinto).
  v_mov_in := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, transferencia_id, tenant_id)
  VALUES (v_mov_in, p_fecha, p_cuenta_destino, 'Transferencia Entrada', NULL,
    p_monto, v_detalle, v_local_dst, v_transf_id, v_tenant);

  PERFORM _auditar('movimientos', 'TRANSFERENCIA', jsonb_build_object(
    'mov_out', v_mov_out, 'mov_in', v_mov_in, 'monto', p_monto,
    'origen', p_cuenta_origen, 'destino', p_cuenta_destino,
    'local_origen', p_local_id, 'local_destino', v_local_dst,
    'cross_local', v_cross_local,
    'transferencia_id', v_transf_id,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object(
    'mov_out', v_mov_out,
    'mov_in', v_mov_in,
    'transferencia_id', v_transf_id,
    'cross_local', v_cross_local
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
