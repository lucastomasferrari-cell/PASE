-- Permite anular liquidaciones cuando se anula el movimiento de pago de sueldo
ALTER TABLE rrhh_liquidaciones ADD COLUMN IF NOT EXISTS anulado BOOLEAN DEFAULT false;
