-- Tabla de auditoría para cambios sensibles (ajustes de saldo, ediciones, eliminaciones)

CREATE TABLE IF NOT EXISTS auditoria (
  id SERIAL PRIMARY KEY,
  tabla TEXT,
  accion TEXT,
  detalle TEXT,
  fecha TIMESTAMPTZ DEFAULT NOW()
);

-- Columnas por si la tabla ya existía con otro schema
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS tabla TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS accion TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS detalle TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS fecha TIMESTAMPTZ DEFAULT NOW();

-- RLS permisiva para usuarios autenticados
ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'auditoria' AND policyname = 'auditoria_all'
  ) THEN
    CREATE POLICY "auditoria_all" ON auditoria FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
