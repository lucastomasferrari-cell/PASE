CREATE TABLE caja_efectivo (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha date NOT NULL DEFAULT CURRENT_DATE,
  descripcion text NOT NULL,
  monto numeric(12,2) NOT NULL,
  local_id integer NOT NULL REFERENCES locales(id),
  creado_por text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE caja_efectivo ENABLE ROW LEVEL SECURITY;

CREATE POLICY "caja_efectivo_dueno" ON caja_efectivo
  FOR ALL TO authenticated USING (true);
