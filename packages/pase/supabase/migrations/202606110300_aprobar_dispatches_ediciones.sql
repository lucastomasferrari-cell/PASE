-- 202606110300_aprobar_dispatches_ediciones.sql
-- Lucas 10-jun: "Claramente tiene que llevar todo el cambio para que cuando
-- yo lo acepte se haga automaticamente". Cierre el último gap del bug de
-- aprobaciones: ahora editar_movimiento y editar_gasto también se
-- auto-ejecutan al aprobar.
--
-- El FE ya manda los valores nuevos en el context (Caja.tsx y Gastos.tsx,
-- commit ddee). Acá extendemos fn_aprobar_solicitud para que cuando
-- la acción sea editar_movimiento / editar_gasto, despache a la RPC final
-- con esos valores. Si los valores nuevos no están en el context (caso
-- legacy de solicitudes viejas que se aprueban tarde), cae al flow del
-- token UUID para que el empleado retry desde su pantalla.

CREATE OR REPLACE FUNCTION fn_aprobar_solicitud(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_solicitud RECORD;
  v_token TEXT;
  v_factura_id TEXT;
  v_mov_id TEXT;
  v_gasto_id TEXT;
  v_motivo TEXT;
  v_ejecutada BOOLEAN := FALSE;
  v_error_msg TEXT;
  v_ctx JSONB;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede aprobar';
  END IF;

  SELECT * INTO v_solicitud FROM manager_solicitudes WHERE id = p_id FOR UPDATE;
  IF v_solicitud IS NULL THEN
    RAISE EXCEPTION 'SOLICITUD_NO_ENCONTRADA';
  END IF;
  IF v_solicitud.tenant_id <> auth_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;
  IF v_solicitud.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'SOLICITUD_ESTADO_INVALIDO: %', v_solicitud.estado;
  END IF;
  IF v_solicitud.expires_at < now() THEN
    UPDATE manager_solicitudes SET estado = 'expirada' WHERE id = p_id;
    RAISE EXCEPTION 'SOLICITUD_EXPIRADA';
  END IF;

  v_token := gen_random_uuid()::TEXT;
  v_ctx := v_solicitud.context;

  UPDATE manager_solicitudes
    SET estado = 'aprobada',
        aprobada_por_usuario_id = auth_usuario_id(),
        aprobada_at = now(),
        token = v_token
    WHERE id = p_id;

  v_motivo := COALESCE(v_ctx->>'motivo', 'autorizado por dueño');
  v_motivo := format('[Solicitud #%s · pedida por user %s] %s',
                     v_solicitud.id, v_solicitud.creada_por_usuario_id, v_motivo);

  BEGIN
    CASE v_solicitud.accion
      WHEN 'anular_factura' THEN
        v_factura_id := v_ctx->>'factura_id';
        IF v_factura_id IS NOT NULL THEN
          PERFORM anular_factura(v_factura_id, v_motivo);
          v_ejecutada := TRUE;
        END IF;
      WHEN 'anular_movimiento', 'anular_pago' THEN
        v_mov_id := COALESCE(v_ctx->>'movimiento_id', v_ctx->>'mov_id');
        IF v_mov_id IS NOT NULL THEN
          PERFORM anular_movimiento(v_mov_id, v_motivo);
          v_ejecutada := TRUE;
        END IF;
      WHEN 'anular_gasto' THEN
        v_gasto_id := v_ctx->>'gasto_id';
        IF v_gasto_id IS NOT NULL THEN
          PERFORM anular_gasto(v_gasto_id, v_motivo);
          v_ejecutada := TRUE;
        END IF;

      -- ── EDICIONES (Lucas 10-jun, fix raíz) ────────────────────────────
      -- Las claves nuevo_* las setea el FE al pedir autorización. Si NO
      -- están (solicitud legacy o cliente viejo), no se auto-ejecuta y se
      -- cae al flow del token.
      WHEN 'editar_movimiento' THEN
        v_mov_id := COALESCE(v_ctx->>'movimiento_id', v_ctx->>'mov_id');
        IF v_mov_id IS NOT NULL AND v_ctx ? 'nuevo_importe' THEN
          PERFORM editar_movimiento_caja(
            p_mov_id := v_mov_id,
            p_fecha := COALESCE((v_ctx->>'nuevo_fecha')::date, CURRENT_DATE),
            p_detalle := v_ctx->>'nuevo_detalle',
            p_cat := NULLIF(v_ctx->>'nuevo_cat', ''),
            p_importe := (v_ctx->>'nuevo_importe')::numeric,
            p_cuenta := v_ctx->>'nuevo_cuenta',
            -- p_tipo se re-deriva server-side en la RPC final; mandamos
            -- vacio y la RPC respeta el viejo o lo recalcula.
            p_tipo := NULL,
            p_justificativo := COALESCE(v_ctx->>'justificativo', v_motivo),
            p_idempotency_key := format('manager_sol_%s', v_solicitud.id)
          );
          v_ejecutada := TRUE;
        END IF;

      WHEN 'editar_gasto' THEN
        v_gasto_id := v_ctx->>'gasto_id';
        IF v_gasto_id IS NOT NULL AND v_ctx ? 'nuevo_monto' THEN
          PERFORM editar_gasto(
            p_gasto_id := v_gasto_id,
            p_fecha := COALESCE((v_ctx->>'nuevo_fecha')::date, CURRENT_DATE),
            p_categoria := v_ctx->>'nuevo_categoria',
            p_tipo := v_ctx->>'nuevo_tipo',
            p_monto := (v_ctx->>'nuevo_monto')::numeric,
            p_cuenta := v_ctx->>'nuevo_cuenta',
            p_detalle := v_ctx->>'nuevo_detalle',
            p_justificativo := COALESCE(v_ctx->>'justificativo', v_motivo),
            p_idempotency_key := format('manager_sol_%s', v_solicitud.id)
          );
          v_ejecutada := TRUE;
        END IF;

      ELSE
        -- Otras acciones (descuento_pos, merma, cortesía, etc.) — flow
        -- viejo del token UUID. El empleado las consume desde su pantalla.
        v_ejecutada := FALSE;
    END CASE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_msg = MESSAGE_TEXT;
    UPDATE manager_solicitudes
      SET rechazo_motivo = format('Auto-ejecución falló: %s', v_error_msg)
      WHERE id = p_id;
    v_ejecutada := FALSE;
  END;

  IF v_ejecutada THEN
    UPDATE manager_solicitudes
      SET estado = 'usada', usada_at = now()
      WHERE id = p_id;
  END IF;

  RETURN v_token;
END;
$$;

NOTIFY pgrst, 'reload schema';
