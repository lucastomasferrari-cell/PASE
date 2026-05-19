-- ═══════════════════════════════════════════════════════════════════════════
-- Hotfix de seguridad CRÍTICO: eliminar_venta / editar_venta / eliminar_cierre
-- aceptan override TOTP del manager.
--
-- Bug reportado por Lucas 2026-05-19: el usuario carovc (Encargado SIN el
-- permiso ventas_anular) pudo borrar una venta sin ningún gate. Causa:
-- las RPCs originales solo chequean local visible, NO permiso ventas_anular.
--
-- Fix: replicamos el patrón ya usado en anular_gasto / editar_gasto /
-- anular_factura — exigir `auth_tiene_permiso_o_override('ventas_anular',
-- p_override_code)`. Si el user tiene el permiso, ejecuta directo. Si no,
-- el frontend tiene que mandar un código TOTP válido del manager.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Drop viejas (cambia signature → necesario por overload de PostgREST) ─
DROP FUNCTION IF EXISTS eliminar_venta(text);
DROP FUNCTION IF EXISTS editar_venta(text, numeric);
DROP FUNCTION IF EXISTS eliminar_cierre(integer, date, text);

-- ─── 2. eliminar_venta con override ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION eliminar_venta(
  p_venta_id      text,
  p_override_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD; v_mov RECORD; v_saldo_delta numeric := 0;
  v_mov_borrado boolean := false; v_tenant uuid;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN RAISE EXCEPTION 'VENTA_ID_REQUERIDO'; END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- Gate principal: el caller tiene permiso ventas_anular O un código TOTP
  -- válido. auth_tiene_permiso_o_override loguea uso del override automáticamente.
  IF NOT auth_tiene_permiso_o_override(
    'ventas_anular',
    p_override_code,
    'eliminar_venta',
    jsonb_build_object('venta_id', p_venta_id, 'monto', v_venta.monto, 'local_id', v_venta.local_id)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso ventas_anular o código del manager';
  END IF;

  -- Gate adicional: el local de la venta debe estar dentro de los locales
  -- visibles del caller (defense-in-depth multi-local, regla histórica).
  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: local fuera de scope';
  END IF;
  v_tenant := v_venta.tenant_id;

  SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[p_venta_id]::text[] LIMIT 1;

  IF v_mov.id IS NOT NULL THEN
    IF array_length(v_mov.venta_ids, 1) = 1 THEN
      DELETE FROM movimientos WHERE id = v_mov.id;
      v_saldo_delta := v_mov.importe;
      v_mov_borrado := true;
    ELSE
      UPDATE movimientos
         SET importe = importe - v_venta.monto,
             venta_ids = array_remove(venta_ids, p_venta_id)
       WHERE id = v_mov.id;
      v_saldo_delta := v_venta.monto;
    END IF;
    IF v_mov.local_id IS NOT NULL THEN
      UPDATE saldos_caja SET saldo = saldo - v_saldo_delta
       WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
    END IF;
  END IF;

  DELETE FROM ventas WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'ELIMINAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id, 'monto', v_venta.monto, 'medio', v_venta.medio,
    'local_id', v_venta.local_id, 'fecha', v_venta.fecha, 'turno', v_venta.turno,
    'mov_id', v_mov.id, 'mov_borrado', v_mov_borrado,
    'saldo_delta', v_saldo_delta, 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('venta_id', p_venta_id, 'mov_id', v_mov.id,
    'mov_borrado', v_mov_borrado, 'saldo_delta', v_saldo_delta);
END;
$$;

-- ─── 3. editar_venta con override ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION editar_venta(
  p_venta_id      text,
  p_nuevo_monto   numeric,
  p_override_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD; v_mov RECORD; v_delta numeric; v_tenant uuid;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN RAISE EXCEPTION 'VENTA_ID_REQUERIDO'; END IF;
  IF p_nuevo_monto IS NULL OR p_nuevo_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF NOT auth_tiene_permiso_o_override(
    'ventas_anular',
    p_override_code,
    'editar_venta',
    jsonb_build_object('venta_id', p_venta_id, 'monto_nuevo', p_nuevo_monto, 'local_id', v_venta.local_id)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso ventas_anular o código del manager';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: local fuera de scope';
  END IF;
  v_tenant := v_venta.tenant_id;

  v_delta := p_nuevo_monto - v_venta.monto;
  IF v_delta != 0 THEN
    SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[p_venta_id]::text[] LIMIT 1;
    IF v_mov.id IS NOT NULL THEN
      UPDATE movimientos SET importe = importe + v_delta WHERE id = v_mov.id;
      IF v_mov.local_id IS NOT NULL THEN
        UPDATE saldos_caja SET saldo = saldo + v_delta
         WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
      END IF;
    END IF;
  END IF;

  UPDATE ventas SET monto = p_nuevo_monto WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'EDITAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id, 'monto_anterior', v_venta.monto,
    'monto_nuevo', p_nuevo_monto, 'delta', v_delta,
    'local_id', v_venta.local_id, 'mov_id', v_mov.id,
    'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('venta_id', p_venta_id, 'monto_nuevo', p_nuevo_monto,
    'delta', v_delta, 'mov_ajustado', v_mov.id IS NOT NULL);
END;
$$;

-- ─── 4. eliminar_cierre con override ────────────────────────────────────────
CREATE OR REPLACE FUNCTION eliminar_cierre(
  p_local_id      integer,
  p_fecha         date,
  p_turno         text,
  p_override_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD; v_mov RECORD; v_saldo_delta numeric;
  v_ventas_borradas int := 0; v_movs_borrados int := 0;
  v_movs_actualizados int := 0; v_contiene_legacy boolean := false;
  v_venta_ids_borrados text[] := ARRAY[]::text[];
  v_total_borrado numeric := 0; v_tenant uuid;
BEGIN
  IF p_local_id IS NULL OR p_fecha IS NULL OR p_turno IS NULL OR length(p_turno) = 0 THEN
    RAISE EXCEPTION 'PARAMETROS_REQUERIDOS';
  END IF;

  IF NOT auth_tiene_permiso_o_override(
    'ventas_anular',
    p_override_code,
    'eliminar_cierre',
    jsonb_build_object('local_id', p_local_id, 'fecha', p_fecha, 'turno', p_turno)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso ventas_anular o código del manager';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: local fuera de scope';
  END IF;

  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;

  -- Loop por ventas del cierre.
  FOR v_venta IN SELECT * FROM ventas WHERE local_id = p_local_id AND fecha = p_fecha AND turno = p_turno LOOP
    SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[v_venta.id]::text[] LIMIT 1;
    IF v_mov.id IS NOT NULL THEN
      IF array_length(v_mov.venta_ids, 1) = 1 THEN
        DELETE FROM movimientos WHERE id = v_mov.id;
        IF v_mov.local_id IS NOT NULL THEN
          UPDATE saldos_caja SET saldo = saldo - v_mov.importe
           WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
        END IF;
        v_movs_borrados := v_movs_borrados + 1;
      ELSE
        UPDATE movimientos
           SET importe = importe - v_venta.monto,
               venta_ids = array_remove(venta_ids, v_venta.id)
         WHERE id = v_mov.id;
        IF v_mov.local_id IS NOT NULL THEN
          UPDATE saldos_caja SET saldo = saldo - v_venta.monto
           WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
        END IF;
        v_movs_actualizados := v_movs_actualizados + 1;
      END IF;
    ELSE
      v_contiene_legacy := true;
    END IF;
    v_total_borrado := v_total_borrado + v_venta.monto;
    v_venta_ids_borrados := array_append(v_venta_ids_borrados, v_venta.id);
    DELETE FROM ventas WHERE id = v_venta.id;
    v_ventas_borradas := v_ventas_borradas + 1;
  END LOOP;

  PERFORM _auditar('ventas', 'ELIMINAR_CIERRE', jsonb_build_object(
    'local_id', p_local_id, 'fecha', p_fecha, 'turno', p_turno,
    'ventas_borradas', v_ventas_borradas, 'movs_borrados', v_movs_borrados,
    'movs_actualizados', v_movs_actualizados, 'total_borrado', v_total_borrado,
    'contiene_legacy', v_contiene_legacy, 'venta_ids', v_venta_ids_borrados,
    'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object(
    'ventas_borradas', v_ventas_borradas,
    'movs_borrados', v_movs_borrados,
    'movs_actualizados', v_movs_actualizados,
    'total_borrado', v_total_borrado,
    'contiene_legacy', v_contiene_legacy
  );
END;
$$;

-- ─── 5. Grants ──────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION eliminar_venta(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION editar_venta(text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION eliminar_cierre(integer, date, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
