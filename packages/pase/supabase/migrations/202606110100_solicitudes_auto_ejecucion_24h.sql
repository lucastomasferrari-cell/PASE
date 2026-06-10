-- 202606110100_solicitudes_auto_ejecucion_24h.sql
-- Lucas 10-jun: "agos me dijo que hizo unos cambios que pidio autorizacion y
-- yo se la di, pero dice que no cambio nada". Diagnóstico (10-jun): 9 de las
-- 14 solicitudes "aprobadas" NUNCA se ejecutaron en DB porque el empleado
-- cerró la pantalla antes de que el frontend pudiera consumir el token.
--
-- 3 fixes en una migración (solución general, no parche):
--
-- 1) AUTO-EJECUCIÓN: fn_aprobar_solicitud despacha la acción AHÍ MISMO desde
--    el servidor para las acciones que tienen todos los args en el context
--    (anular_factura, anular_movimiento, anular_gasto). No depende del
--    empleado volver a la pantalla. El flow del token UUID se mantiene para
--    acciones que SÍ requieren input del empleado (descuento_pos, mermas,
--    editar_*  — éstas no se auto-ejecutan porque el context no tiene los
--    valores nuevos).
--
-- 2) DURACIÓN 24H: las solicitudes pendientes ahora valen 24 horas (antes 1h
--    desde el 3-jun, y 15 min antes). Lucas no siempre ve el push al instante;
--    24h es lo que se siente como "el día".
--
-- 3) EXPIRACIÓN AUTOMÁTICA en el listado: fn_listar_solicitudes_pendientes
--    ahora marca como 'expirada' las que pasaron el deadline en lugar de
--    devolverlas como pendientes. Las vencidas quedan visibles en la pestaña
--    "Expiradas" pero NO molestan en el contador de Pendientes del inicio.

-- ── 1. Default 24h ──────────────────────────────────────────────────────
ALTER TABLE manager_solicitudes
  ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '24 hours');

COMMENT ON COLUMN manager_solicitudes.expires_at IS
  'Cuándo expira la solicitud si el manager no responde. Default 24h '
  '(cambiado 2026-06-10 desde 1h — Lucas: "que duren 24hs").';

-- ── 2. Helper: auto-expirar pendientes vencidas ─────────────────────────
-- Lo llama fn_listar_solicitudes_pendientes antes de devolver. Patrón Stripe:
-- mejor expirar al leer que tener un cron que recorre toda la tabla.
CREATE OR REPLACE FUNCTION fn_auto_expirar_solicitudes()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INTEGER; BEGIN
  WITH expiradas AS (
    UPDATE manager_solicitudes
    SET estado = 'expirada'
    WHERE tenant_id = auth_tenant_id()
      AND estado = 'pendiente'
      AND expires_at < now()
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM expiradas;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION fn_auto_expirar_solicitudes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_auto_expirar_solicitudes() TO authenticated;

-- ── 3. fn_listar_solicitudes_pendientes auto-expira antes de leer ───────
CREATE OR REPLACE FUNCTION fn_listar_solicitudes_pendientes()
RETURNS TABLE (
  id BIGINT,
  accion TEXT,
  context JSONB,
  creador_nombre TEXT,
  creador_id INTEGER,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin';
  END IF;
  PERFORM fn_auto_expirar_solicitudes();
  RETURN QUERY
    SELECT ms.id, ms.accion, ms.context,
           (SELECT u.nombre FROM usuarios u WHERE u.id = ms.creada_por_usuario_id),
           ms.creada_por_usuario_id,
           ms.created_at, ms.expires_at
    FROM manager_solicitudes ms
    WHERE ms.tenant_id = auth_tenant_id()
      AND ms.estado = 'pendiente'
      AND ms.expires_at > now()
    ORDER BY ms.created_at DESC;
END;
$$;

-- ── 4. Auto-ejecución al aprobar (la solución general al bug) ───────────
-- La aprobación del dueño dispatchea la acción AHÍ MISMO. Las acciones
-- determinísticas (anular_*) se ejecutan sin depender del empleado. Si
-- la acción es de las que requieren input del empleado (descuento_pos,
-- editar_*), el flow viejo del token UUID se mantiene como fallback.
--
-- Si la auto-ejecución falla, NO marca como usada — el token queda válido
-- para que el empleado retry manualmente. Así nunca empeora.

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

  -- Marca como aprobada con token (el token sirve de fallback si la
  -- auto-ejecución falla; el empleado puede retry manual).
  UPDATE manager_solicitudes
    SET estado = 'aprobada',
        aprobada_por_usuario_id = auth_usuario_id(),
        aprobada_at = now(),
        token = v_token
    WHERE id = p_id;

  -- ── Auto-ejecutar la acción (solo para acciones determinísticas) ─────
  -- Las RPCs anular_* corren bien con auth.uid()=dueño (auth_es_dueno_o_admin
  -- pasa al instante, no toca override). El motivo se prefija con
  -- "[via manager_solicitud N° {id}]" para trazabilidad.
  v_motivo := COALESCE(v_solicitud.context->>'motivo', 'autorizado por dueño');
  v_motivo := format('[Solicitud #%s · pedida por user %s] %s',
                     v_solicitud.id, v_solicitud.creada_por_usuario_id, v_motivo);

  BEGIN
    CASE v_solicitud.accion
      WHEN 'anular_factura' THEN
        v_factura_id := v_solicitud.context->>'factura_id';
        IF v_factura_id IS NOT NULL THEN
          PERFORM anular_factura(v_factura_id, v_motivo);
          v_ejecutada := TRUE;
        END IF;
      WHEN 'anular_movimiento', 'anular_pago' THEN
        v_mov_id := COALESCE(v_solicitud.context->>'movimiento_id', v_solicitud.context->>'mov_id');
        IF v_mov_id IS NOT NULL THEN
          PERFORM anular_movimiento(v_mov_id, v_motivo);
          v_ejecutada := TRUE;
        END IF;
      WHEN 'anular_gasto' THEN
        v_gasto_id := v_solicitud.context->>'gasto_id';
        IF v_gasto_id IS NOT NULL THEN
          PERFORM anular_gasto(v_gasto_id, v_motivo);
          v_ejecutada := TRUE;
        END IF;
      ELSE
        -- Acciones que requieren input del empleado: dejar el flow viejo
        -- (editar_movimiento, editar_gasto, descuento_pos, merma, etc.)
        v_ejecutada := FALSE;
    END CASE;
  EXCEPTION WHEN OTHERS THEN
    -- La auto-ejecución falló (mov ya anulado, factura ya anulada,
    -- restricción de integridad, etc.). NO se marca como usada —
    -- el token sigue válido y Lucas ve el error en el listado.
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
