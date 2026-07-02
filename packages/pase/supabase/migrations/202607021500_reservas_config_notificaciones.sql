-- Config editable desde el admin (antes eran valores fijos en código/SQL):
--  - email obligatorio al reservar
--  - on/off de cada mail (confirmación / recordatorio / reseña) + hora de envío
ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_email_obligatorio boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reservas_notif_confirmacion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reservas_notif_recordatorio boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reservas_notif_resena boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reservas_notif_hora integer NOT NULL DEFAULT 11;

-- Maneki: email obligatorio (lo pidió Lucas). Resto queda en los defaults.
UPDATE comanda_local_settings SET reservas_email_obligatorio = true WHERE local_id = 4;
