-- ═══════════════════════════════════════════════════════════════════════════
-- Permisos granulares *_anular en RPCs anular_*.
--
-- A-2 de la auditoría: hoy quien tiene permiso "compras" puede anular
-- facturas/remitos via RPC (las RPCs solo validan local autorizado, no
-- permiso fino). Esta migration agrega chequeo de permiso granular:
--   anular_factura, anular_remito → requiere 'compras_anular' (regla C11)
--   anular_movimiento              → requiere 'caja_anular' (regla C11)
--
-- ROLES.compras y ROLES.cajero default-incluyen el permiso correspondiente
-- (retro-compat). Lucas puede quitar el permiso de un usuario específico
-- desde Usuarios → Permisos avanzados.
--
-- Los chequeos se hacen en las primeras 5 líneas de cada RPC (cumple linter
-- Supabase y la regla C11 documentada en CLAUDE.md).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION anular_factura(p_factura_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_fac RECORD; v_tenant uuid;
BEGIN
  -- Auth granular (A-2 de la auditoría) — dueño/admin pasan siempre.
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras_anular')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_YA_ANULADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  UPDATE facturas SET estado = 'anulada' WHERE id = p_factura_id;

  PERFORM _auditar('facturas', 'ANULACION', jsonb_build_object(
    'factura_id', p_factura_id, 'motivo', p_motivo,
    'estado_previo', v_fac.estado, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada');
END;
$$;

CREATE OR REPLACE FUNCTION anular_remito(p_remito_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_r RECORD; v_tenant uuid;
BEGIN
  -- Auth granular (A-2 de la auditoría) — dueño/admin pasan siempre.
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras_anular')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  UPDATE remitos SET estado = 'anulado' WHERE id = p_remito_id;

  PERFORM _auditar('remitos', 'ANULACION', jsonb_build_object(
    'remito_id', p_remito_id, 'motivo', p_motivo,
    'estado_previo', v_r.estado, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('remito_id', p_remito_id, 'estado', 'anulado');
END;
$$;

-- anular_movimiento con chequeo de caja_anular. Reescribimos full porque
-- la RPC vive en 202604281206 — sin tocar lógica del cuerpo, solo agregamos
-- el chequeo en las primeras 5 líneas. SECURITY DEFINER para consistencia
-- con anular_factura/anular_remito (estaba como SECURITY INVOKER en la
-- versión 202604281206:945 pero RLS no aporta nada acá dado que _validar_
-- local_autorizado ya valida el local).
CREATE OR REPLACE FUNCTION anular_movimiento(p_mov_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov RECORD; v_pareja RECORD; v_gasto_id text;
  v_anulados text[] := ARRAY[]::text[]; v_tenant uuid;
BEGIN
  -- Auth granular (A-2 de la auditoría) — dueño/admin pasan siempre.
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('caja_anular')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso caja_anular';
  END IF;

  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);
  v_tenant := v_mov.tenant_id;

  IF v_mov.transferencia_id IS NOT NULL THEN
    FOR v_pareja IN SELECT * FROM movimientos
     WHERE transferencia_id = v_mov.transferencia_id AND anulado IS DISTINCT FROM TRUE
     ORDER BY id LOOP
      PERFORM _validar_local_autorizado(v_pareja.local_id);
      UPDATE movimientos SET anulado = true, anulado_motivo = p_motivo WHERE id = v_pareja.id;
      IF v_pareja.local_id IS NOT NULL THEN
        PERFORM _actualizar_saldo_caja(v_pareja.cuenta, v_pareja.local_id, -COALESCE(v_pareja.importe, 0));
      END IF;
      v_anulados := array_append(v_anulados, v_pareja.id);
    END LOOP;

    PERFORM _auditar('movimientos', 'ANULACION_TRANSFERENCIA', jsonb_build_object(
      'mov_id_solicitado', p_mov_id, 'transferencia_id', v_mov.transferencia_id,
      'movs_anulados', to_jsonb(v_anulados), 'motivo', p_motivo,
      'usuario_id', auth_usuario_id()
    ), v_tenant);

    RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true,
      'transferencia_id', v_mov.transferencia_id, 'movs_anulados', to_jsonb(v_anulados));
  END IF;

  UPDATE movimientos SET anulado = true, anulado_motivo = p_motivo WHERE id = p_mov_id;
  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  IF v_mov.liquidacion_id IS NOT NULL THEN
    UPDATE rrhh_liquidaciones SET anulado = true WHERE id = v_mov.liquidacion_id;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
    SELECT id INTO v_gasto_id FROM gastos
     WHERE detalle = v_mov.detalle AND fecha = v_mov.fecha
       AND cuenta = v_mov.cuenta AND local_id = v_mov.local_id
     LIMIT 1;
    IF v_gasto_id IS NOT NULL THEN
      UPDATE rrhh_liquidaciones SET anulado = true WHERE gasto_id = v_gasto_id;
    END IF;
  END IF;

  PERFORM _auditar('movimientos', 'ANULACION', jsonb_build_object(
    'mov_id', p_mov_id, 'motivo', p_motivo,
    'movimiento', to_jsonb(v_mov), 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$$;
