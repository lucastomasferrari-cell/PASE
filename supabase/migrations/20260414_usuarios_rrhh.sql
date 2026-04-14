-- USUARIOS: agregar columnas a tabla existente
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol TEXT DEFAULT 'encargado' CHECK (rol IN ('dueno', 'admin', 'encargado'));

-- PERMISOS POR MÓDULO (sí/no)
CREATE TABLE IF NOT EXISTS usuario_permisos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo_slug TEXT NOT NULL,
  UNIQUE(usuario_id, modulo_slug)
);

-- LOCALES POR USUARIO (para encargados)
CREATE TABLE IF NOT EXISTS usuario_locales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  local_id UUID REFERENCES locales(id) ON DELETE CASCADE,
  UNIQUE(usuario_id, local_id)
);

-- EMPLEADOS RRHH
CREATE TABLE IF NOT EXISTS rrhh_empleados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id UUID REFERENCES locales(id),
  apellido TEXT NOT NULL,
  nombre TEXT NOT NULL,
  cuil TEXT,
  puesto TEXT NOT NULL,
  modo_pago TEXT NOT NULL CHECK (modo_pago IN ('MENSUAL', 'QUINCENAL', 'SEMANAL')),
  sueldo_mensual NUMERIC NOT NULL,
  valor_dia NUMERIC GENERATED ALWAYS AS (sueldo_mensual / 30.0) STORED,
  valor_hora NUMERIC GENERATED ALWAYS AS (sueldo_mensual / 30.0 / 8.0) STORED,
  alias_mp TEXT,
  fecha_inicio DATE,
  activo BOOLEAN DEFAULT true,
  creado_at TIMESTAMPTZ DEFAULT now()
);

-- NOVEDADES MENSUALES (una por empleado por mes, el encargado puede editar hasta confirmar)
CREATE TABLE IF NOT EXISTS rrhh_novedades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empleado_id UUID REFERENCES rrhh_empleados(id) ON DELETE CASCADE,
  mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  anio INTEGER NOT NULL,
  inasistencias NUMERIC DEFAULT 0,
  presentismo TEXT DEFAULT 'MANTIENE' CHECK (presentismo IN ('MANTIENE', 'PIERDE', 'PIERDE_LLEGADAS', 'INICIO_PARCIAL')),
  dias_trabajados NUMERIC,
  horas_extras NUMERIC DEFAULT 0,
  dobles NUMERIC DEFAULT 0,
  pagos_dobles_realizados NUMERIC DEFAULT 0,
  feriados NUMERIC DEFAULT 0,
  adelantos NUMERIC DEFAULT 0,
  vacaciones_dias NUMERIC DEFAULT 0,
  observaciones TEXT,
  estado TEXT DEFAULT 'borrador' CHECK (estado IN ('borrador', 'confirmado')),
  cargado_por UUID REFERENCES usuarios(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(empleado_id, mes, anio)
);

-- LIQUIDACIONES (calculado al confirmar)
CREATE TABLE IF NOT EXISTS rrhh_liquidaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  novedad_id UUID REFERENCES rrhh_novedades(id) ON DELETE CASCADE UNIQUE,
  sueldo_base NUMERIC,
  descuento_ausencias NUMERIC DEFAULT 0,
  total_horas_extras NUMERIC DEFAULT 0,
  total_dobles NUMERIC DEFAULT 0,
  total_feriados NUMERIC DEFAULT 0,
  total_vacaciones NUMERIC DEFAULT 0,
  subtotal1 NUMERIC,
  monto_presentismo NUMERIC DEFAULT 0,
  subtotal2 NUMERIC,
  adelantos NUMERIC DEFAULT 0,
  pagos_realizados NUMERIC DEFAULT 0,
  total_a_pagar NUMERIC,
  efectivo NUMERIC DEFAULT 0,
  transferencia NUMERIC DEFAULT 0,
  calculado_at TIMESTAMPTZ DEFAULT now()
);

-- VALOR DE DOBLES POR PUESTO (configurable)
CREATE TABLE IF NOT EXISTS rrhh_valores_doble (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  puesto TEXT NOT NULL UNIQUE,
  valor NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Valores iniciales de dobles (del Excel)
INSERT INTO rrhh_valores_doble (puesto, valor) VALUES
  ('SUSHIMAN', 25000), ('COCINERO', 25000), ('BACHERO', 20000),
  ('CAMARERO', 15000), ('RECEPCIONISTA', 10000), ('BARTENDER', 15000),
  ('EMPAQUE', 15000), ('CAJERO', 20000), ('PRODUCCION', 15000),
  ('APRENDIZ DE SUSHI', 15000), ('JEFE DE SUSHI', 30000), ('ENCARGADO', 30000),
  ('ADMINISTRATIVO', 20000), ('GERENTE', 30000)
ON CONFLICT (puesto) DO NOTHING;

-- RLS
ALTER TABLE usuario_permisos ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_locales ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_empleados ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_novedades ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_liquidaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_valores_doble ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usuarios autenticados" ON usuario_permisos FOR ALL USING (true);
CREATE POLICY "usuarios autenticados" ON usuario_locales FOR ALL USING (true);
CREATE POLICY "usuarios autenticados" ON rrhh_empleados FOR ALL USING (true);
CREATE POLICY "usuarios autenticados" ON rrhh_novedades FOR ALL USING (true);
CREATE POLICY "usuarios autenticados" ON rrhh_liquidaciones FOR ALL USING (true);
CREATE POLICY "usuarios autenticados" ON rrhh_valores_doble FOR ALL USING (true);
