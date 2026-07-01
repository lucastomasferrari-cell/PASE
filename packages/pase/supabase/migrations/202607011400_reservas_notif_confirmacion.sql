-- Marca de confirmación enviada al cliente (email/WA automático).
-- Evita mandar dos veces la misma confirmación (idempotencia del endpoint
-- público /api/reserva-notificar).
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS notif_confirmacion_at TIMESTAMPTZ;
