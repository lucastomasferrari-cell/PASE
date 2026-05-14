-- ═══════════════════════════════════════════════════════════════════════════
-- CHECK constraint en proveedores.estado para enforcar el casing
--
-- Fecha:    2026-05-14
-- Por qué:  El frontend (Compras.tsx:265, ConciliacionMP.tsx:319, LectorFacturasIA.tsx:74)
--           filtra `estado = 'Activo'` (capital A). Pero la columna no tiene
--           CHECK constraint que enforce el casing — cualquier insert/update
--           con 'activo' (lowercase) o 'ACTIVO' (mayúsculas) hace que el
--           proveedor desaparezca silenciosamente del dropdown. Bug fragility
--           detectado en auditoría 2026-05-09.
--
-- Cambios:
--   1. UPDATE defensivo: normaliza casing si hay filas con 'activo'/'ACTIVO'.
--      No-op si todas las filas ya están en 'Activo'/'Inactivo'.
--   2. ADD CONSTRAINT que solo permite 'Activo' o 'Inactivo' (o NULL).
--
-- Si esta migration falla con violación de check, significa que hay un valor
-- raro en `estado` (ej. "vigente", "deshabilitado") que no se mapeó. Revisar
-- los valores con: SELECT DISTINCT estado FROM proveedores;
-- ═══════════════════════════════════════════════════════════════════════════

-- Normalización defensiva. WHERE filtra solo filas que necesitan cambio.
UPDATE proveedores
SET estado = CASE
  WHEN lower(estado) = 'activo' THEN 'Activo'
  WHEN lower(estado) = 'inactivo' THEN 'Inactivo'
  ELSE estado
END
WHERE estado IS NOT NULL
  AND estado NOT IN ('Activo', 'Inactivo');

-- Agregar CHECK constraint. DROP IF EXISTS para idempotencia (re-correr la
-- migration no falla).
ALTER TABLE proveedores DROP CONSTRAINT IF EXISTS proveedores_estado_check;

ALTER TABLE proveedores
  ADD CONSTRAINT proveedores_estado_check
  CHECK (estado IS NULL OR estado IN ('Activo', 'Inactivo'));
