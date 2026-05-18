-- ═══════════════════════════════════════════════════════════════════════════
-- Anular RPCs con soporte de manager override
-- Sesión 2026-05-18
--
-- Continúa migration 202605180000 (TOTP). Upgradea anular_factura,
-- anular_remito y anular_gasto para aceptar un código de override opcional.
-- Si el caller no tiene 'compras_anular' pero presenta un código TOTP válido,
-- la operación procede y queda registrada en manager_override_usos.
--
-- Caso de uso típico: empleado intenta anular una factura mal cargada. No
-- tiene permiso compras_anular. El frontend muestra modal pidiendo código,
-- el dueño se lo dicta, lo tipea, la RPC se ejecuta con p_override_code.
--
-- Estas 3 RPCs son SECURITY DEFINER y ya validan permiso en sus primeras
-- líneas (regla C11). Solo cambiamos la condición:
--   ANTES: IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso(...)) THEN RAISE...
--   AHORA: IF NOT auth_tiene_permiso_o_override(...) THEN RAISE...
--
-- El nombre del PERMISO sigue siendo 'compras_anular' en los 3 casos
-- (gastos reusa el mismo permiso, decisión Lucas previa). El contexto
-- pasado al override incluye el id del objeto y el motivo para auditoría.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── anular_factura: agrega p_override_code ────────────────────────────────
CREATE OR REPLACE FUNCTION anular_factura(
  p_factura_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_fac RECORD; v_tenant uuid;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_factura',
    jsonb_build_object('factura_id', p_factura_id, 'motivo', p_motivo)
  ) THEN
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
    'estado_previo', v_fac.estado, 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada');
END;
$$;

-- ─── anular_remito: agrega p_override_code ─────────────────────────────────
CREATE OR REPLACE FUNCTION anular_remito(
  p_remito_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_r RECORD; v_tenant uuid;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_remito',
    jsonb_build_object('remito_id', p_remito_id, 'motivo', p_motivo)
  ) THEN
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
    'estado_previo', v_r.estado, 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('remito_id', p_remito_id, 'estado', 'anulado');
END;
$$;

-- ─── anular_gasto: agrega p_override_code ──────────────────────────────────
-- Esta tiene más lógica interna (revierte movimientos + saldo). Solo cambio
-- el check de permiso del principio, el resto del cuerpo queda igual.
CREATE OR REPLACE FUNCTION anular_gasto(
  p_gasto_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_gasto RECORD;
  v_mov RECORD;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_gasto',
    jsonb_build_object('gasto_id', p_gasto_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_motivo IS NULL OR trim(p_motivo) = '' THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  SELECT * INTO v_gasto FROM gastos WHERE id = p_gasto_id;
  IF v_gasto IS NULL THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;
  IF COALESCE(v_gasto.estado, 'activo') = 'anulado' THEN
    RAISE EXCEPTION 'GASTO_YA_ANULADO';
  END IF;

  PERFORM _validar_local_autorizado(v_gasto.local_id);

  -- Marcar gasto anulado
  UPDATE gastos
    SET estado = 'anulado',
        anulado_motivo = p_motivo,
        anulado_at = NOW(),
        anulado_por = v_usuario_id
    WHERE id = p_gasto_id;

  -- Buscar el movimiento asociado y anularlo (revirtiendo saldo)
  SELECT * INTO v_mov FROM movimientos WHERE gasto_id_ref = p_gasto_id AND anulado = FALSE;
  IF v_mov.id IS NOT NULL THEN
    UPDATE movimientos
      SET anulado = TRUE, anulado_motivo = 'Anulación del gasto: ' || p_motivo
      WHERE id = v_mov.id;
    IF v_mov.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
    END IF;
  END IF;

  PERFORM _auditar('gastos', 'ANULACION', jsonb_build_object(
    'gasto_id', p_gasto_id, 'motivo', p_motivo,
    'usuario_id', v_usuario_id,
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('gasto_id', p_gasto_id, 'estado', 'anulado', 'caller_uid', v_caller_uid);
END;
$$;

NOTIFY pgrst, 'reload schema';
