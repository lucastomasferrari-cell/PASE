-- Novedades: fecha de inicio en el mes (para altas a mitad de mes)
ALTER TABLE rrhh_novedades ADD COLUMN IF NOT EXISTS fecha_inicio_mes DATE;

-- Unificamos a pago mensual: se elimina modo_pago de empleados
ALTER TABLE rrhh_empleados DROP COLUMN IF EXISTS modo_pago;
