-- Marca anti-doble-envío del mail de recordatorio (el día de la reserva).
-- El de confirmación usa notif_confirmacion_at y el de reseña notif_resena_at.
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS notif_recordatorio_at timestamptz;
