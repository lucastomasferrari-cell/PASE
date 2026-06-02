-- 202606021500_crons_f5.sql
-- Brainstorm #8 Fase 5 Chunk E — Crons.
--
-- 3 RPCs para automatizaciones programadas:
--   1. fn_cron_recordatorio_reservas() — manda push a admins (sus apps PWA)
--      avisando reservas confirmadas que vencen en ~1h.
--   2. fn_cron_solicitar_resenas() — para ventas entregadas hace 15-25 min,
--      marca la venta como "reseña solicitada" + dispara notif (igual que
--      el flow normal de marketplace).
--   3. fn_cron_emitir_cupones_cumple() — diario, busca clientes que cumplen
--      ese día y les crea cupón personal CUMPLE-<id> con 7 días vigencia.
--
-- Scheduling: usa pg_cron al final (extensión activa en Supabase Pro).
-- Si pg_cron no está activado, el último bloque falla silenciosamente
-- pero las RPCs quedan creadas — Lucas puede correr el scheduling después.
--
-- Decisiones default:
--  - Cupón cumple: 15% off, válido 7 días, monto_min $1000, max_usos=1.
--  - Recordatorio reserva: solo se manda 1 vez (idempotency via columna).
--  - Reseña solicitada: solo se marca 1 vez por venta (mismo patrón).

-- ─── 1. Columnas nuevas ─────────────────────────────────────────────────────
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS recordatorio_enviado_at TIMESTAMPTZ NULL;

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS resena_solicitada_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN reservas.recordatorio_enviado_at IS
  'Cuando el cron envió el recordatorio 1h antes. Idempotency natural. F5 Chunk E.';
COMMENT ON COLUMN ventas_pos.resena_solicitada_at IS
  'Cuando el cron pidió reseña post-entrega (15min después). Idempotency. F5 Chunk E.';

-- ─── 2. RPC: recordatorio reservas 1h antes ─────────────────────────────────
-- Busca reservas confirmadas con fecha_hora entre +55min y +65min,
-- sin recordatorio_enviado_at. Marca + retorna count.
-- El envío real del push lo hace un wrapper externo (worker/endpoint)
-- que lee admin_push_subscriptions del tenant y dispara WebPush.
-- Acá solo marcamos + retornamos la lista de reservas a notificar.
CREATE OR REPLACE FUNCTION fn_cron_recordatorio_reservas()
RETURNS TABLE (
  reserva_id BIGINT,
  tenant_id UUID,
  local_id INTEGER,
  cliente_nombre TEXT,
  cliente_telefono TEXT,
  cliente_email TEXT,
  fecha_hora TIMESTAMPTZ,
  personas INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_window_start TIMESTAMPTZ := v_now + INTERVAL '55 minutes';
  v_window_end TIMESTAMPTZ := v_now + INTERVAL '65 minutes';
BEGIN
  -- Marcar recordatorio_enviado_at + retornar las que necesitan notif.
  RETURN QUERY
  UPDATE reservas r SET recordatorio_enviado_at = v_now
   WHERE r.estado = 'confirmada'
     AND r.fecha_hora BETWEEN v_window_start AND v_window_end
     AND r.recordatorio_enviado_at IS NULL
     AND r.deleted_at IS NULL
  RETURNING r.id, r.tenant_id, r.local_id, r.cliente_nombre,
            r.cliente_telefono, r.cliente_email, r.fecha_hora, r.personas;
END;
$$;

REVOKE ALL ON FUNCTION fn_cron_recordatorio_reservas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cron_recordatorio_reservas() TO authenticated, service_role;

-- ─── 3. RPC: solicitar reseña post-entrega ──────────────────────────────────
-- Busca ventas con estado='entregada' y entregada_at entre -25min y -15min,
-- sin resena_solicitada_at. Marca + retorna lista para notif.
-- Por defecto solo envío reseña para ventas con cliente_email (sin email
-- no hay forma de mandar el link — el WhatsApp es futuro).
CREATE OR REPLACE FUNCTION fn_cron_solicitar_resenas()
RETURNS TABLE (
  venta_id BIGINT,
  tenant_id UUID,
  local_id INTEGER,
  cliente_nombre TEXT,
  cliente_email TEXT,
  numero_local INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_window_start TIMESTAMPTZ := v_now - INTERVAL '25 minutes';
  v_window_end TIMESTAMPTZ := v_now - INTERVAL '15 minutes';
BEGIN
  RETURN QUERY
  UPDATE ventas_pos vp SET resena_solicitada_at = v_now
   WHERE vp.estado = 'entregada'
     AND vp.entregada_at BETWEEN v_window_start AND v_window_end
     AND vp.resena_solicitada_at IS NULL
     AND vp.cliente_email IS NOT NULL
     AND vp.origen = 'tienda_online'  -- solo tienda online tiene reseñas hoy
     AND vp.deleted_at IS NULL
  RETURNING vp.id, vp.tenant_id, vp.local_id, vp.cliente_nombre,
            vp.cliente_email, vp.numero_local;
END;
$$;

REVOKE ALL ON FUNCTION fn_cron_solicitar_resenas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cron_solicitar_resenas() TO authenticated, service_role;

-- ─── 4. RPC: cupón cumpleaños diario ────────────────────────────────────────
-- Busca clientes que cumplen HOY. Crea cupón personal CUMPLE-<id> con
-- 15% off, vigencia 7 días, monto_min $1000, max_usos=1.
-- Idempotency: si ya existe cupón CUMPLE-<id> activo, no duplica.
CREATE OR REPLACE FUNCTION fn_cron_emitir_cupones_cumple()
RETURNS TABLE (
  cliente_id BIGINT,
  tenant_id UUID,
  cliente_nombre TEXT,
  cupon_code TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := CURRENT_DATE;
  v_today_month INTEGER := EXTRACT(MONTH FROM v_today)::INTEGER;
  v_today_day INTEGER := EXTRACT(DAY FROM v_today)::INTEGER;
  v_cliente RECORD;
  v_code TEXT;
  v_cupon_id BIGINT;
  v_locales_tenant INTEGER;
BEGIN
  FOR v_cliente IN
    SELECT c.id, c.tenant_id, c.nombre, c.apellido
      FROM clientes c
     WHERE c.deleted_at IS NULL
       AND c.fecha_nacimiento IS NOT NULL
       AND EXTRACT(MONTH FROM c.fecha_nacimiento)::INTEGER = v_today_month
       AND EXTRACT(DAY FROM c.fecha_nacimiento)::INTEGER = v_today_day
  LOOP
    v_code := 'CUMPLE-' || v_cliente.id;

    -- Idempotency: si ya existe activo, skip
    IF EXISTS (
      SELECT 1 FROM cupones
       WHERE tenant_id = v_cliente.tenant_id
         AND code = v_code
         AND activo = TRUE
         AND deleted_at IS NULL
    ) THEN
      CONTINUE;
    END IF;

    -- Insertar cupón. local_id NULL = aplica a todos los locales del tenant.
    INSERT INTO cupones (
      tenant_id, local_id, code, descripcion, tipo, valor,
      fecha_desde, fecha_hasta, monto_min_compra,
      max_usos, max_usos_por_cliente, solo_primera_compra, activo
    ) VALUES (
      v_cliente.tenant_id, NULL, v_code,
      'Cupón cumpleaños ' || COALESCE(v_cliente.nombre, '') || ' ' || COALESCE(v_cliente.apellido, ''),
      'porcentaje', 15,
      v_today, v_today + INTERVAL '7 days', 1000,
      1, 1, FALSE, TRUE
    ) RETURNING id INTO v_cupon_id;

    cliente_id := v_cliente.id;
    tenant_id := v_cliente.tenant_id;
    cliente_nombre := COALESCE(v_cliente.nombre, '') || ' ' || COALESCE(v_cliente.apellido, '');
    cupon_code := v_code;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION fn_cron_emitir_cupones_cumple() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cron_emitir_cupones_cumple() TO authenticated, service_role;

-- ─── 5. Scheduling con pg_cron (Supabase Pro) ───────────────────────────────
-- Estos statements requieren la extensión pg_cron activa (default en
-- Supabase Pro y Free Plus). Si falla por permisos o extensión faltante,
-- el resto de la migration sigue OK — Lucas puede correr el scheduling
-- manualmente después.
--
-- Para listar crons activos: SELECT * FROM cron.job;
-- Para deshabilitar: SELECT cron.unschedule('nombre-del-job');

-- Recordatorio reservas: cada 5 min
DO $$
BEGIN
  -- Limpiar versión anterior si existe (idempotente)
  PERFORM cron.unschedule('f5-recordatorio-reservas') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'f5-recordatorio-reservas'
  );
  PERFORM cron.schedule(
    'f5-recordatorio-reservas',
    '*/5 * * * *',
    $cmd$ SELECT fn_cron_recordatorio_reservas(); $cmd$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible o sin permisos — scheduling manual pendiente. Error: %', SQLERRM;
END $$;

-- Solicitar reseñas: cada 5 min
DO $$
BEGIN
  PERFORM cron.unschedule('f5-solicitar-resenas') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'f5-solicitar-resenas'
  );
  PERFORM cron.schedule(
    'f5-solicitar-resenas',
    '*/5 * * * *',
    $cmd$ SELECT fn_cron_solicitar_resenas(); $cmd$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible o sin permisos — scheduling manual pendiente. Error: %', SQLERRM;
END $$;

-- Cupones cumple: diario 9:00 UTC = 6:00 AR (mañana temprano del cumpleañero)
DO $$
BEGIN
  PERFORM cron.unschedule('f5-cupones-cumple') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'f5-cupones-cumple'
  );
  PERFORM cron.schedule(
    'f5-cupones-cumple',
    '0 9 * * *',  -- 9:00 UTC = 6:00 AM Argentina (UTC-3)
    $cmd$ SELECT fn_cron_emitir_cupones_cumple(); $cmd$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible o sin permisos — scheduling manual pendiente. Error: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
