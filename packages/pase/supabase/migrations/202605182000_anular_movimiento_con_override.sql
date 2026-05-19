-- ═══════════════════════════════════════════════════════════════════════════
-- anular_movimiento con gate de permiso + Manager Override
-- Sesión 2026-05-18 (Lucas: "anular movimiento agregalo")
--
-- Hasta hoy esta RPC era SECURITY INVOKER sin gate de permiso explícito —
-- cualquier user con acceso al local (vía RLS) podía anular movimientos.
--
-- Cambio: agregamos check `auth_tiene_permiso_o_override('compras_anular', ...)`
-- al inicio. Si el caller tiene el permiso, pasa directo. Si no, necesita
-- presentar un código TOTP válido (vía p_override_code).
--
-- ⚠️ REGRESIÓN: usuarios que ANTES podían anular movimientos sin tener
-- 'compras_anular' explícito ahora van a necesitar override. Si hay
-- encargados que rutinariamente anulaban movs propios, hay que darles el
-- permiso o adaptarse al flow de override.
--
-- El resto del cuerpo de la RPC queda EXACTAMENTE igual (reversión saldo,
-- liquidación, aguinaldo, adelantos, etc.). Solo cambia el primer check.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION anular_movimiento(
  p_mov_id text,
  p_motivo text,
  p_override_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_mov RECORD;
  v_liq RECORD;
  v_emp_id uuid;
  v_movs_restantes integer;
  v_delta_aguinaldo numeric;
  v_gasto_id text;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  -- Gate de permiso / manager override. auth_tiene_permiso_o_override es
  -- SECURITY DEFINER (bypassa RLS, valida el código TOTP + consume si OK).
  -- Si el caller tiene 'compras_anular', pasa directo sin tocar el código.
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_movimiento',
    jsonb_build_object('mov_id', p_mov_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- Revertir saldo de caja
  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  -- Si el movimiento estaba asociado a una liquidación de sueldo: lógica completa.
  IF v_mov.liquidacion_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = v_mov.liquidacion_id;

    SELECT COUNT(*) INTO v_movs_restantes
      FROM movimientos
     WHERE liquidacion_id = v_mov.liquidacion_id AND anulado IS NOT TRUE;

    IF v_movs_restantes = 0 THEN
      IF v_liq.estado = 'pagado' THEN
        SELECT n.empleado_id INTO v_emp_id
          FROM rrhh_novedades n
         WHERE n.id = v_liq.novedad_id;
        IF v_emp_id IS NOT NULL THEN
          v_delta_aguinaldo := COALESCE(v_liq.total_a_pagar, 0) / 12.0;
          UPDATE rrhh_empleados
             SET aguinaldo_acumulado = GREATEST(0, COALESCE(aguinaldo_acumulado, 0) - v_delta_aguinaldo)
           WHERE id = v_emp_id;
        END IF;
      END IF;

      UPDATE rrhh_adelantos
         SET descontado = false,
             liquidacion_consumidora_id = NULL
       WHERE liquidacion_consumidora_id = v_mov.liquidacion_id;

      UPDATE rrhh_liquidaciones
         SET anulado = true,
             pagos_realizados = 0,
             estado = 'pendiente',
             pagado_at = NULL,
             pagado_por = NULL
       WHERE id = v_mov.liquidacion_id;
    ELSE
      UPDATE rrhh_liquidaciones
         SET pagos_realizados = GREATEST(0, COALESCE(pagos_realizados, 0) - ABS(COALESCE(v_mov.importe, 0)))
       WHERE id = v_mov.liquidacion_id;
    END IF;
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
    'movimiento', to_jsonb(v_mov), 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ));

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
