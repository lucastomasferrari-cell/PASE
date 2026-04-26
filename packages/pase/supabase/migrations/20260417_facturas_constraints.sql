-- BUG #2: Verificar/eliminar constraint UNIQUE en facturas.nro
-- Ejecutar en Supabase SQL Editor

-- 1) Listar constraints actuales (pegar output al asistente)
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'facturas';

-- 2) Si aparece una constraint tipo UNIQUE sobre "nro" (e.g. facturas_nro_key), eliminarla:
-- ALTER TABLE facturas DROP CONSTRAINT IF EXISTS facturas_nro_key;
