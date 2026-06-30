-- ============================================================
-- anular_remito: permitir anular remitos PAGADOS revirtiendo el pago.
--
-- Antes: anular_remito solo marcaba el remito como anulado y NO tocaba el
-- pago → por eso la UI ocultaba el botón en remitos pagados (anularlos
-- descuadraba la caja: la plata quedaba gastada sin remito que la justifique).
--
-- Ahora: si el remito está PAGADO, también anula el/los movimiento(s) de pago
-- (remito_id_ref = remito) y revierte el saldo de caja, en la misma
-- transacción. Replica la reversión de saldo de anular_movimiento
-- (_actualizar_saldo_caja(cuenta, local, -importe)).
--
-- Auth: igual que antes — permiso `compras_anular` o código TOTP del dueño
-- (auth_tiene_permiso_o_override). Un encargado con el código puede anular.
-- ============================================================

CREATE OR REPLACE FUNCTION anular_remito(
  p_remito_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_r RECORD;
  v_tenant uuid;
  v_mov RECORD;
  v_pagos_revertidos int := 0;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_remito',
    jsonb_build_object('remito_id', p_remito_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id FOR UPDATE;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  -- Si está pagado: revertir el/los movimiento(s) de pago antes de anular.
  IF v_r.estado = 'pagado' THEN
    FOR v_mov IN
      SELECT * FROM movimientos
       WHERE remito_id_ref = p_remito_id
         AND tenant_id = v_tenant
         AND anulado IS NOT TRUE
       FOR UPDATE
    LOOP
      UPDATE movimientos
         SET anulado = true,
             anulado_motivo = 'Anulación de remito ' || COALESCE(v_r.nro, p_remito_id)
       WHERE id = v_mov.id;
      PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
      v_pagos_revertidos := v_pagos_revertidos + 1;
    END LOOP;
  END IF;

  UPDATE remitos SET estado = 'anulado' WHERE id = p_remito_id;

  PERFORM _auditar('remitos', 'ANULACION', jsonb_build_object(
    'remito_id', p_remito_id, 'motivo', p_motivo,
    'estado_previo', v_r.estado, 'pagos_revertidos', v_pagos_revertidos,
    'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object(
    'remito_id', p_remito_id, 'estado', 'anulado',
    'pagos_revertidos', v_pagos_revertidos
  );
END;
$$;
