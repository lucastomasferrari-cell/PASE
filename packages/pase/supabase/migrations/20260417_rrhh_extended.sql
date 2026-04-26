-- RRHH: pagos especiales, documentos, historial de sueldos + columnas extra en rrhh_empleados

CREATE TABLE IF NOT EXISTS rrhh_pagos_especiales (
  id SERIAL PRIMARY KEY,
  empleado_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  monto NUMERIC DEFAULT 0,
  dias NUMERIC DEFAULT 0,
  gasto_id TEXT,
  pagado_por TEXT,
  pagado_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rrhh_documentos (
  id SERIAL PRIMARY KEY,
  empleado_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  nombre_archivo TEXT,
  url TEXT,
  mes INTEGER,
  anio INTEGER,
  subido_por TEXT,
  subido_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rrhh_historial_sueldos (
  id SERIAL PRIMARY KEY,
  empleado_id TEXT NOT NULL,
  sueldo_anterior NUMERIC DEFAULT 0,
  sueldo_nuevo NUMERIC DEFAULT 0,
  motivo TEXT,
  registrado_por TEXT,
  fecha_cambio TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rrhh_pagos_especiales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rrhh_pagos_esp_all" ON rrhh_pagos_especiales FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE rrhh_documentos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rrhh_docs_all" ON rrhh_documentos FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE rrhh_historial_sueldos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rrhh_hist_all" ON rrhh_historial_sueldos FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS aguinaldo_acumulado NUMERIC DEFAULT 0;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS vacaciones_dias_acumulados NUMERIC DEFAULT 0;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS fecha_egreso DATE;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS motivo_baja TEXT;
