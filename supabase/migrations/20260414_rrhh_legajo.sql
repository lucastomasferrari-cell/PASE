-- Historial de sueldos (cuando se edita el sueldo de un empleado)
CREATE TABLE IF NOT EXISTS rrhh_historial_sueldos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empleado_id UUID REFERENCES rrhh_empleados(id) ON DELETE CASCADE,
  sueldo_anterior NUMERIC NOT NULL,
  sueldo_nuevo NUMERIC NOT NULL,
  fecha_cambio DATE DEFAULT CURRENT_DATE,
  motivo TEXT,
  registrado_por INTEGER REFERENCES usuarios(id)
);

-- Documentos del empleado (alta, DNI, recibos, etc)
CREATE TABLE IF NOT EXISTS rrhh_documentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empleado_id UUID REFERENCES rrhh_empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('alta_temprana', 'dni', 'recibo_sueldo', 'baja', 'contrato', 'otro')),
  nombre_archivo TEXT NOT NULL,
  url TEXT NOT NULL,
  mes INTEGER,
  anio INTEGER,
  subido_por INTEGER REFERENCES usuarios(id),
  subido_at TIMESTAMPTZ DEFAULT now()
);

-- Pagos de vacaciones y aguinaldo
CREATE TABLE IF NOT EXISTS rrhh_pagos_especiales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empleado_id UUID REFERENCES rrhh_empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('vacaciones', 'aguinaldo')),
  monto NUMERIC NOT NULL,
  dias NUMERIC,
  periodo_desde DATE,
  periodo_hasta DATE,
  gasto_id UUID,
  pagado_at TIMESTAMPTZ DEFAULT now(),
  pagado_por INTEGER REFERENCES usuarios(id)
);

-- Agregar campos a rrhh_liquidaciones
ALTER TABLE rrhh_liquidaciones ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado'));
ALTER TABLE rrhh_liquidaciones ADD COLUMN IF NOT EXISTS gasto_id UUID;
ALTER TABLE rrhh_liquidaciones ADD COLUMN IF NOT EXISTS pagado_at TIMESTAMPTZ;
ALTER TABLE rrhh_liquidaciones ADD COLUMN IF NOT EXISTS pagado_por INTEGER REFERENCES usuarios(id);

-- Agregar campos a rrhh_empleados para acumular vacaciones y aguinaldo
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS vacaciones_dias_acumulados NUMERIC DEFAULT 0;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS aguinaldo_acumulado NUMERIC DEFAULT 0;

-- RLS
ALTER TABLE rrhh_historial_sueldos ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_documentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_pagos_especiales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON rrhh_historial_sueldos FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON rrhh_documentos FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "allow all" ON rrhh_pagos_especiales FOR ALL TO authenticated USING (true) WITH CHECK (true);
