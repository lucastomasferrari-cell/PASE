-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 7 — Sesión 4
--
-- BLOCKER #4 (auditoría 2026-05-07): documentar deuda explícita en la
-- policy facturas_read_mt sobre el branch legacy "tenant Neko".
--
-- NO se elimina el branch hoy porque rompería la operación actual de Neko.
-- Se documenta como COMMENT y se deja un script de backfill template en
-- packages/pase/scripts/backfill_storage_facturas_legacy.sql para ejecutar
-- pre-onboarding del segundo tenant productivo.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'facturas_read_mt') THEN
    EXECUTE $cmt$
      COMMENT ON POLICY facturas_read_mt ON storage.objects IS
      'DEUDA TÉCNICA (sprint 7, BLOCKER #4 auditoría 2026-05-07): branch legacy permite paths sin UUID prefix si caller es Neko. Antes de onboardear segundo tenant productivo, ejecutar packages/pase/scripts/backfill_storage_facturas_legacy.sql y crear migration que elimina el branch legacy.';
    $cmt$;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN sesión 4 (sprint 7)
-- ═══════════════════════════════════════════════════════════════════════════
