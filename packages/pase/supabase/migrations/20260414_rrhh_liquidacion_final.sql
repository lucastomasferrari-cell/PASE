-- Campos para liquidación final en rrhh_empleados
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS fecha_egreso DATE;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS motivo_baja TEXT;

-- Permitir tipo liquidacion_final en pagos especiales
ALTER TABLE rrhh_pagos_especiales DROP CONSTRAINT IF EXISTS rrhh_pagos_especiales_tipo_check;
ALTER TABLE rrhh_pagos_especiales ADD CONSTRAINT rrhh_pagos_especiales_tipo_check
  CHECK (tipo IN ('vacaciones', 'aguinaldo', 'liquidacion_final'));
