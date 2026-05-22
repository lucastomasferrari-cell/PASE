-- ═══════════════════════════════════════════════════════════════════════════
-- Quincenas: novedades separadas por cuota dentro del mes
--
-- Pedido Lucas 21-may noche: hoy se arma 1 liquidación por mes y el pago se
-- divide. Quiere que cuando un empleado es QUINCENAL aparezca DOS VECES en
-- la lista de novedades del mes (Primera Quincena + Segunda Quincena), con
-- novedades editables independientemente. Cada novedad genera su propia
-- liquidación. Sin descuentos cruzados.
--
-- Cambios:
--   1. Agregar cuota_num + cuotas_total a rrhh_novedades.
--   2. Cambiar UNIQUE de (empleado, mes, anio) → (empleado, mes, anio, cuota_num).
--   3. CHECK constraint: cuotas_total IN (1, 2, 4), cuota_num <= cuotas_total.
--
-- Las novedades existentes quedan con cuota_num=1, cuotas_total=1 (mensual).
-- NO se migran automáticamente — para convertir una mensual a quincenal,
-- el usuario la elimina y vuelve a entrar (el frontend genera los 2 slots
-- en blanco según emp.modo_pago).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE rrhh_novedades
  ADD COLUMN IF NOT EXISTS cuota_num INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cuotas_total INT NOT NULL DEFAULT 1;

ALTER TABLE rrhh_novedades DROP CONSTRAINT IF EXISTS rrhh_novedades_empleado_id_mes_anio_key;

CREATE UNIQUE INDEX IF NOT EXISTS rrhh_novedades_empleado_mes_cuota_key
  ON rrhh_novedades (empleado_id, mes, anio, cuota_num);

ALTER TABLE rrhh_novedades
  DROP CONSTRAINT IF EXISTS rrhh_novedades_cuota_check;
ALTER TABLE rrhh_novedades
  ADD CONSTRAINT rrhh_novedades_cuota_check
  CHECK (cuota_num >= 1 AND cuota_num <= cuotas_total AND cuotas_total IN (1, 2, 4));

NOTIFY pgrst, 'reload schema';
