-- ═══════════════════════════════════════════════════════════════════════════
-- Limpieza: rrhh_novedades.presentismo solo acepta MANTIENE | PIERDE
--
-- Fecha:    2026-05-14
-- Contexto: el CHECK original (20260414_usuarios_rrhh:46) aceptaba 4 valores:
--   MANTIENE, PIERDE, PIERDE_LLEGADAS, INICIO_PARCIAL
-- Pero la UI (TabNovedades.tsx + helpers.ts:48-51) solo expone 2:
--   - MANTIENE ("Tiene")
--   - PIERDE ("No tiene")
--
-- En prod (verificado 2026-05-14): 4 filas, TODAS con valor MANTIENE.
-- PIERDE_LLEGADAS y INICIO_PARCIAL nunca se usaron — son artifacts de un
-- diseño previo que se simplificó pero el CHECK no se actualizó.
--
-- Riesgo: si una fila tuviera PIERDE_LLEGADAS o INICIO_PARCIAL, la UI
-- mostraría "Tiene" (default) pero la lógica de cálculo trataría como
-- "no MANTIENE" (sin bonus 5%). Inconsistencia silenciosa.
--
-- Fix: alinear el CHECK con la UI. Si alguna vez queremos las otras 2
-- opciones, hay que agregarlas también a helpers.ts:PRESENTISMO_OPTS.
-- ═══════════════════════════════════════════════════════════════════════════

-- Defensive: por si hay alguna fila con valor fuera del set permitido nuevo,
-- normalizar a PIERDE (más seguro contable — no suma bonus).
UPDATE rrhh_novedades
SET presentismo = 'PIERDE'
WHERE presentismo NOT IN ('MANTIENE', 'PIERDE');

ALTER TABLE rrhh_novedades DROP CONSTRAINT IF EXISTS rrhh_novedades_presentismo_check;
ALTER TABLE rrhh_novedades
  ADD CONSTRAINT rrhh_novedades_presentismo_check
  CHECK (presentismo IN ('MANTIENE', 'PIERDE'));
