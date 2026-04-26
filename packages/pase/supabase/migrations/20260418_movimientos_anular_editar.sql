-- Soft delete y trazabilidad de ediciones en movimientos
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS anulado BOOLEAN DEFAULT false;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS anulado_motivo TEXT;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS editado BOOLEAN DEFAULT false;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS editado_motivo TEXT;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS editado_at TIMESTAMPTZ;

-- Idempotente: las columnas de auditoria ya están en 20260418_auditoria.sql.
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS tabla TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS accion TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS detalle TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS fecha TIMESTAMPTZ DEFAULT NOW();
