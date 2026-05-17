-- ─── Snooze auto-revive: reactivar items agotados al vencer agotado_hasta ────
-- Sprint 16/05: el dueño marca "Sin salmón hasta las 21hs" → el item se
-- reactiva automático sin que nadie se acuerde de venir a marcar disponible.
--
-- Implementado con pg_cron (extensión de Supabase). Corre cada minuto y
-- pone disponible cualquier item con estado='agotado' AND agotado_hasta <
-- NOW(). No usa egress (corre en el servidor).
--
-- Si el dueño marca agotado sin "hasta", queda agotado indefinido como antes.

CREATE OR REPLACE FUNCTION fn_reactivar_items_vencidos()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE items
     SET estado = 'disponible',
         agotado_motivo = NULL,
         agotado_por = NULL,
         agotado_at = NULL,
         agotado_hasta = NULL,
         updated_at = NOW()
   WHERE estado = 'agotado'
     AND agotado_hasta IS NOT NULL
     AND agotado_hasta < NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Snooze auto-revive: % items reactivados', v_count;
  END IF;
  RETURN v_count;
END;
$$;

-- Schedule con pg_cron — corre cada minuto.
-- IMPORTANTE: pg_cron debe estar habilitado en el proyecto (default en Supabase).
-- Si la extensión no existe, comentar este bloque y llamar fn_reactivar_items_vencidos()
-- desde el cliente o un endpoint Vercel cron como fallback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule si ya existe (por idempotencia de re-runs)
    PERFORM cron.unschedule('reactivar-items-vencidos')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reactivar-items-vencidos');
    -- Schedule cada minuto
    PERFORM cron.schedule(
      'reactivar-items-vencidos',
      '* * * * *',  -- every minute
      $cron$SELECT public.fn_reactivar_items_vencidos();$cron$
    );
    RAISE NOTICE 'pg_cron schedule creado: reactivar-items-vencidos cada minuto';
  ELSE
    RAISE WARNING 'pg_cron NO disponible. Ejecutá fn_reactivar_items_vencidos() manualmente o desde un cron Vercel.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
