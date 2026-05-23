-- ═══════════════════════════════════════════════════════════════════════════
-- Nuevo grupo de gasto "Juicios y Demandas" — independiente de Fijos
--
-- Lucas 22-may noche: "no es un gasto fijo eso, en todo caso es un gasto
-- independiente, como fijos, variables, impuestos, juicios y demandas, y
-- que ahi este abogado, indemnizaciones, juicios y demandas".
--
-- Cambios:
--   1. gastos.tipo: agregar 'juicios_demandas' al CHECK.
--   2. config_categorias.tipo: agregar 'gasto_juicios_demandas' (sin CHECK
--      formal porque la tabla no tiene check actualmente).
--   3. Re-clasificar las 3 categorías creadas en migration 202605223700
--      (JUICIOS Y DEMANDAS, ABOGADO / LEGAL, INDEMNIZACIONES) que estaban
--      como 'gasto_fijo' → moverlas a 'gasto_juicios_demandas'.
--   4. Agregar grupo para que aparezcan en useCategorias().
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Extender CHECK de gastos.tipo
ALTER TABLE gastos DROP CONSTRAINT IF EXISTS gastos_tipo_check;
ALTER TABLE gastos ADD CONSTRAINT gastos_tipo_check
  CHECK (tipo = ANY (ARRAY[
    'fijo'::text, 'variable'::text, 'publicidad'::text,
    'comision'::text, 'impuesto'::text, 'retiro_socio'::text,
    'empleado'::text,
    'juicios_demandas'::text  -- NUEVO 22-may: juicios, abogados, indemnizaciones
  ]));

-- 2. Re-clasificar las 3 categorías que ya estaban como 'gasto_fijo'.
-- Las creé en migration 202605223700 como gasto_fijo (error), ahora las
-- pongo en el grupo correcto.
UPDATE config_categorias
   SET tipo = 'gasto_juicios_demandas', orden = 10
 WHERE nombre IN ('JUICIOS Y DEMANDAS', 'ABOGADO / LEGAL', 'INDEMNIZACIONES')
   AND tipo = 'gasto_fijo';

NOTIFY pgrst, 'reload schema';
