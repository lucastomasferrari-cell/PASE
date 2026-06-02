-- 202606021600_unschedule_crons_f5.sql
-- Brainstorm #8 Fase 5 Chunk E — Wrapper de crons F5 (follow-up).
--
-- En la migration 202606021500 programamos las 3 RPCs cron con pg_cron.
-- Problema: pg_cron solo ejecuta SQL — no manda email ni push web. Si
-- pg_cron las llama, las filas quedan marcadas (con timestamp) pero los
-- emails/push NO salen. El wrapper Vercel (notif-pendientes-process del
-- bot IG) las llamaría después y no encontraría nada para procesar.
--
-- Solución: deshabilitar pg_cron de estas 3 RPCs. El wrapper Vercel las
-- llama cada 5 min (workflow notif-pendientes-cron.yml) — eso garantiza
-- que email/push se mandan junto con el marcado del timestamp.
--
-- Idempotente: si los crons no existen, no rompe.

DO $$
BEGIN
  PERFORM cron.unschedule('f5-recordatorio-reservas') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'f5-recordatorio-reservas'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule recordatorio fail: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('f5-solicitar-resenas') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'f5-solicitar-resenas'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule resenas fail: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('f5-cupones-cumple') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'f5-cupones-cumple'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule cumples fail: %', SQLERRM;
END $$;

-- Las RPCs fn_cron_* siguen existiendo y siendo callable. Solo cambiamos
-- QUIÉN las invoca (de pg_cron a wrapper Vercel).
