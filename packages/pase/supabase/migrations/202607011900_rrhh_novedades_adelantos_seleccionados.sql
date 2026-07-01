-- Bug 1 (Anto 01-jul): al confirmar novedades, el tildado de "Ya pagado"
-- (qué adelantos/gastos del empleado se descuentan de la liquidación) se
-- perdía porque vivía SOLO en state del navegador. Al recargar volvía todo
-- desmarcado → el total subía (contaba de nuevo lo ya pagado en el mes vía
-- Caja Chica) y el split efectivo/MP quedaba corto. Además, tras confirmar
-- los checkboxes quedan bloqueados → no se podía corregir.
--
-- Fix: persistir la selección en la propia fila de la novedad. Es un array de
-- ids de rrhh_adelantos que el usuario marcó para descontar. Se guarda al
-- Confirmar/Pagar (junto con el resto de la novedad) y se re-hidrata al cargar.
--
-- Sin cambios de RLS: es una columna más en rrhh_novedades, cubierta por la
-- política existente (rrhh_novedades_mt / rrhh_nov_scope_all).
ALTER TABLE rrhh_novedades
  ADD COLUMN IF NOT EXISTS adelantos_seleccionados uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN rrhh_novedades.adelantos_seleccionados IS
  'IDs de rrhh_adelantos marcados como "Ya pagado / descontar" en esta liquidación. Se persiste al confirmar; pagar_sueldo consume estos adelantos.';
