-- ═══════════════════════════════════════════════════════════════════════════
-- Performance — Índice compuesto para listados de ventas_pos por fecha
-- ═══════════════════════════════════════════════════════════════════════════
-- Auditoría 2026-05-15: AllChecks (`allChecksService.ts:46-72`) y otros
-- listados ordenan ventas_pos por `created_at DESC` filtrando por local_id.
-- El índice existente `idx_vp_local_estado(local_id, estado)` cubre el filtro
-- pero NO el ORDER BY, por lo que Postgres hace bitmap scan + sort en
-- memoria.
--
-- Con 30 días × 50 ventas/día/local × 5 locales = 7,500 rows, el sort en
-- memoria todavía es barato; con 90 días en producción real escala mal.
--
-- Este índice resuelve los listados típicos:
--   SELECT ... FROM ventas_pos
--   WHERE local_id = $1 AND deleted_at IS NULL
--   ORDER BY created_at DESC LIMIT N;

CREATE INDEX IF NOT EXISTS idx_vp_local_created_at_desc
  ON ventas_pos (local_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_vp_local_created_at_desc IS
  'Listados de ventas_pos por local ordenados por fecha. Cubre allChecksService, historial pedidos, reportes. Filtro WHERE deleted_at IS NULL reduce tamaño del índice descartando ventas borradas.';
