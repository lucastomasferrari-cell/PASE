-- BUG #3: Agregar columnas Perc. IVA, Otros Cargos, Descuentos a facturas
-- IMPORTANTE: Ejecutar en Supabase SQL Editor ANTES de usar la nueva UI,
-- de lo contrario el INSERT fallará por columnas inexistentes.

ALTER TABLE facturas ADD COLUMN IF NOT EXISTS perc_iva NUMERIC DEFAULT 0;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS otros_cargos NUMERIC DEFAULT 0;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS descuentos NUMERIC DEFAULT 0;
