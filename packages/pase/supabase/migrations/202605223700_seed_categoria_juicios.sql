-- Seed categorías RRHH genéricas (no requieren empleado)
-- Lucas 22-may noche: para juicios/abogados/indemnizaciones que no van a UN empleado.

INSERT INTO config_categorias (tenant_id, nombre, tipo, orden, activo)
SELECT t.id, c.nombre, c.tipo, c.orden, true
FROM tenants t
CROSS JOIN (VALUES
  ('JUICIOS Y DEMANDAS', 'gasto_fijo', 80),
  ('ABOGADO / LEGAL', 'gasto_fijo', 81),
  ('INDEMNIZACIONES', 'gasto_fijo', 82)
) AS c(nombre, tipo, orden)
WHERE t.activo = true
  AND NOT EXISTS (
    SELECT 1 FROM config_categorias cc
    WHERE cc.tenant_id = t.id AND cc.nombre = c.nombre
  );
