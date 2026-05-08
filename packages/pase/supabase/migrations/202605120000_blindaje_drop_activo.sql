-- ═══════════════════════════════════════════════════════════════════════════
-- Blindaje — drop columna `activo` de blindaje_tipos_documento.
--
-- Decisión (Lucas, 2026-05-08): los tipos de documento de Blindaje no
-- necesitan un estado activo/inactivo. Solo se crean o se eliminan. La
-- nueva UI usa DELETE real (con cascade de blindaje_documentos cuando hay
-- PDFs cargados — el frontend pide confirmación con la cuenta antes).
--
-- Esta migration:
--   1. Borra los tipos que estaban en activo=false (eran "papelera virtual",
--      ya no tienen sentido).
--   2. Borra documentos huérfanos cuyo tipo ya no exista en la tabla
--      (defensa por si quedó algún FK roto).
--   3. Drop de la columna activo.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Limpiar tipos inactivos (los marcados como activo=false). Sus documentos
--    asociados quedan limpios cascade-wise gracias al paso 2.
DELETE FROM blindaje_tipos_documento WHERE activo = false;

-- 2) Documentos sin tipo válido (FK roto o tipo borrado en el paso anterior).
DELETE FROM blindaje_documentos
 WHERE tipo_id NOT IN (SELECT id FROM blindaje_tipos_documento);

-- 3) Drop de la columna activo.
ALTER TABLE blindaje_tipos_documento DROP COLUMN IF EXISTS activo;
