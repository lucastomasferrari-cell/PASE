-- ═══════════════════════════════════════════════════════════════════════════
-- ventas — auditoría parser Maxirest
--
-- Agrega 2 columnas a `ventas` para tracking del parser Maxirest v2:
--
--   parser_version TEXT     — qué versión del parser produjo este cierre.
--   campos_editados JSONB   — { campo: { auto, manual } } de los campos que
--                              el usuario editó manualmente en el preview
--                              antes de confirmar el import.
--
-- Ambas son NULL para ventas no-Maxirest (origen != 'maxirest') y para
-- imports que se hicieron antes de este refactor.
--
-- No se borran las columnas existentes. La tabla `ventas` se sigue usando
-- como contenedor de cierres importados (1 fila por medio de cobro).
-- Los campos de auditoría son los mismos para todas las filas del cierre,
-- así que se duplican deliberadamente — alternativa "tabla
-- maxirest_imports" se descartó por simplicidad.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS parser_version  TEXT NULL,
  ADD COLUMN IF NOT EXISTS campos_editados JSONB NULL;

COMMENT ON COLUMN ventas.parser_version IS
  'Versión del parser Maxirest que importó esta venta. NULL para imports '
  'previos al refactor de 2026-05-08 o para ventas no-Maxirest.';

COMMENT ON COLUMN ventas.campos_editados IS
  'JSON con los campos que el usuario editó manualmente en el preview '
  'antes de confirmar el import. Forma: {"turno":{"auto":"Mediodía",'
  '"manual":"Noche"}, ...}. NULL si no hubo ediciones o no aplica.';

-- Index parcial para auditorías futuras: traer todas las filas con
-- ediciones manuales. La tabla ventas no tiene created_at, así que
-- indexamos por fecha (la fecha del cierre).
CREATE INDEX IF NOT EXISTS idx_ventas_campos_editados_set
  ON ventas (fecha)
  WHERE campos_editados IS NOT NULL;
