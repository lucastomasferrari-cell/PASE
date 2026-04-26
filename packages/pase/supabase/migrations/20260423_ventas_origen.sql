-- Flag del origen de cada venta. Permite distinguir cierres cargados a mano
-- de los importados desde Maxirest (esos no deberían ser editables).
-- Valores actuales: 'manual' | 'maxirest'. DEFAULT 'manual' para filas existentes.
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'manual';
