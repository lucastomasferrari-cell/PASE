-- Índice para consultas de auditoría por fecha (auditoría de performance 01-ago)
-- La tabla auditoria crece sin tope y se consulta ordenada por fecha; sin índice
-- de fecha, cada consulta hacía scan. Agrega (tenant_id, fecha DESC).
CREATE INDEX IF NOT EXISTS idx_auditoria_tenant_fecha ON auditoria (tenant_id, fecha DESC);
