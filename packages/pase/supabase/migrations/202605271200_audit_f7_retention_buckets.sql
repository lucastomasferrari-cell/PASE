-- =============================================================================
-- AUDIT F7 — Deuda: retention crons + buckets sensibles a privado
-- =============================================================================
-- F7B#1: 0 retention en tablas que crecen mes a mes. DB infla, queries
-- lentas a futuro, costos de storage. Cron jobs nuevos.
-- F7B#2: buckets `empleados` y `rrhh-documentos` con public=true contienen
-- DNIs, contratos, recibos de sueldo → URL directa accesible sin auth.
-- F7B#10: `*_history` COMANDA sin retention.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- F7B#2: buckets sensibles a privado.
-- NOTA: storage.buckets no se puede modificar desde postgres user (es owner
-- supabase_storage_admin). Lucas debe togglearlo manualmente en el panel
-- Supabase → Storage → empleados / rrhh-documentos → Edit bucket → uncheck
-- "Public bucket". Tarea registrada en project_tareas_manuales_pendientes.md.
-- Una vez togglead, el frontend que use getPublicUrl va a romper UNA vez y
-- requerir migrar a createSignedUrl (TTL configurable).
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- F7B#1+#10: retention crons.
-- -----------------------------------------------------------------------------
-- Función helper que pueden invocar todos los cron jobs.
CREATE OR REPLACE FUNCTION fn_retention_cleanup() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auditoria_borrados int := 0;
  v_ig_eventos_borrados int := 0;
  v_pedidos_log_borrados int := 0;
  v_idempotency_borrados int := 0;
  v_history_borrados int := 0;
  v_n int;
BEGIN
  -- auditoria > 180 días (compliance + investigaciones razonable)
  DELETE FROM auditoria WHERE fecha < now() - interval '180 days';
  GET DIAGNOSTICS v_auditoria_borrados = ROW_COUNT;

  -- ig_eventos > 90 días (operativo, logs de bot)
  DELETE FROM ig_eventos WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_ig_eventos_borrados = ROW_COUNT;

  -- pedidos_externos_log > 30 días (logs de webhooks delivery)
  DELETE FROM pedidos_externos_log WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_pedidos_log_borrados = ROW_COUNT;

  -- idempotency_keys > 7 días (las claves expiran en horas, 7d es buffer largo)
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days';
  GET DIAGNOSTICS v_idempotency_borrados = ROW_COUNT;

  -- *_history COMANDA > 180 días.
  -- Compliance: para auditorías fiscales 6 meses suele alcanzar; si Lucas
  -- quiere más, ajustar el interval acá. Cada tabla individual.
  DELETE FROM ventas_pos_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;
  DELETE FROM mesas_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;
  DELETE FROM ventas_pos_items_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;
  DELETE FROM turnos_caja_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;
  DELETE FROM canales_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;
  DELETE FROM items_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;
  DELETE FROM item_precios_canal_history WHERE changed_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_history_borrados := v_history_borrados + v_n;

  RETURN jsonb_build_object(
    'auditoria', v_auditoria_borrados,
    'ig_eventos', v_ig_eventos_borrados,
    'pedidos_externos_log', v_pedidos_log_borrados,
    'idempotency_keys', v_idempotency_borrados,
    'history_total', v_history_borrados,
    'ran_at', now()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_retention_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_retention_cleanup() TO service_role;

-- Cron job semanal — domingo 3 AM (baja actividad).
-- Si ya existe con otro schedule, lo recreamos.
DO $do$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'retention-cleanup';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  PERFORM cron.schedule(
    'retention-cleanup',
    '0 3 * * 0',                                   -- domingos 03:00
    $cron$SELECT public.fn_retention_cleanup();$cron$
  );
END $do$;

-- =============================================================================
-- SMOKE CHECKS
-- =============================================================================
DO $smoke$
DECLARE v_n integer;
BEGIN
  -- Cron job presente
  SELECT COUNT(*) INTO v_n FROM cron.job WHERE jobname = 'retention-cleanup';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL F7B#1: cron retention-cleanup no creado';
  END IF;
  RAISE NOTICE 'SMOKE OK F7B#1: cron retention-cleanup activo (domingos 3am)';

  -- Función presente
  SELECT COUNT(*) INTO v_n FROM pg_proc WHERE proname = 'fn_retention_cleanup';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL: fn_retention_cleanup no encontrada';
  END IF;
  RAISE NOTICE 'SMOKE OK: fn_retention_cleanup creada';

  -- Buckets: verificar pero NO bloquear (Lucas debe togglear manual)
  SELECT COUNT(*) INTO v_n FROM storage.buckets
   WHERE id IN ('empleados', 'rrhh-documentos') AND public = true;
  IF v_n > 0 THEN
    RAISE WARNING '⚠ F7B#2 PENDING: % bucket(s) sensibles siguen públicos. Lucas debe togglear desde el panel Supabase Storage manualmente.', v_n;
  END IF;
END $smoke$;

COMMIT;
