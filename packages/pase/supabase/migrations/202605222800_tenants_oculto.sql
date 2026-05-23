-- ═══════════════════════════════════════════════════════════════════════════
-- tenants.oculto — flag para esconder tenants del listado superadmin
--
-- Acordado 22-may noche: el tenant "E2E Test Suite" (que ejecuta la suite
-- de tests punta a punta) crea/destruye datos constantemente. NO debe
-- aparecer en el selector de tenants superadmin de Lucas, ni en listados
-- de admin-console, ni contar para métricas de billing.
--
-- Default FALSE: tenants existentes (Neko, etc.) no cambian comportamiento.
-- Solo los tenants creados con oculto=TRUE quedan invisibles.
--
-- Los superadmins igual pueden listarlos con WHERE oculto IS TRUE
-- explícitamente si quieren auditar.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS oculto BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenants.oculto IS
  'Si TRUE, el tenant no aparece en listados/dropdowns de superadmin. Usado para tenants de test (E2E suite). Solo visible con WHERE oculto IS TRUE explícito.';

-- Index parcial: las queries de listado típico filtran "oculto = false",
-- esto permite que sea instantáneo aún con muchos tenants ocultos.
CREATE INDEX IF NOT EXISTS idx_tenants_visibles
  ON tenants(activo)
  WHERE oculto = FALSE AND activo = TRUE;

NOTIFY pgrst, 'reload schema';
