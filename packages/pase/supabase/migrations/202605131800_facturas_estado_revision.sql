-- ═══════════════════════════════════════════════════════════════════════════
-- Bug 2026-05-13: facturas_estado_check rechaza 'revision'.
--
-- El Lector de Facturas IA setea `estado = 'revision'` cuando la confianza
-- global del modelo es < 70% (LectorFacturasIA.tsx:313). Este estado se usa
-- desde hace tiempo y el helper UI (compras/helpers.tsx) ya lo renderiza con
-- warning amarillo + ícono ⚠.
--
-- La migration anterior 202605121600_check_constraints_estados.sql agregó
-- el CHECK constraint listando solo 4 estados (pendiente|vencida|pagada|
-- anulada) sin advertir el caso 'revision'. Resultado: al guardar facturas
-- IA con confianza baja, el INSERT falla con `facturas_estado_check`.
--
-- Reportado por empleado de Lucas el 2026-05-13. Patrón análogo al bug del
-- `tipo NOT NULL` resuelto el mismo día.
--
-- Fix: extender el constraint para incluir 'revision'. Semántica:
--   - 'revision': cargada por Lector IA con baja confianza, requiere
--     verificación humana antes de operar pagos.
--   - 'pendiente': válida y operable para flujo de pago.
--
-- Otras RPCs (pagar_factura, anular_factura) ya operan por id sin filtrar
-- por estado distinto a 'pagada'/'anulada', así que no necesitan cambios.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE facturas DROP CONSTRAINT IF EXISTS facturas_estado_check;

ALTER TABLE facturas
  ADD CONSTRAINT facturas_estado_check
  CHECK (estado IN ('pendiente', 'vencida', 'pagada', 'anulada', 'revision'));
