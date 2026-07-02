-- Templates editables para los 3 mails de reservas.
-- Cada local puede personalizar título y subtítulo de cada mail.
-- NULL = usa el default hardcodeado en el endpoint.

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_tpl_confirmacion_titulo     text,
  ADD COLUMN IF NOT EXISTS reservas_tpl_confirmacion_subtitulo  text,
  ADD COLUMN IF NOT EXISTS reservas_tpl_recordatorio_titulo     text,
  ADD COLUMN IF NOT EXISTS reservas_tpl_recordatorio_subtitulo  text,
  ADD COLUMN IF NOT EXISTS reservas_tpl_resena_titulo           text,
  ADD COLUMN IF NOT EXISTS reservas_tpl_resena_subtitulo        text;

COMMENT ON COLUMN comanda_local_settings.reservas_tpl_confirmacion_titulo IS 'Título del mail de confirmación. Soporta {{nombre}}, {{local}}, {{fecha}}, {{personas}}.';
COMMENT ON COLUMN comanda_local_settings.reservas_tpl_confirmacion_subtitulo IS 'Subtítulo/cuerpo del mail de confirmación.';
COMMENT ON COLUMN comanda_local_settings.reservas_tpl_recordatorio_titulo IS 'Título del mail recordatorio.';
COMMENT ON COLUMN comanda_local_settings.reservas_tpl_recordatorio_subtitulo IS 'Subtítulo/cuerpo del mail recordatorio.';
COMMENT ON COLUMN comanda_local_settings.reservas_tpl_resena_titulo IS 'Título del mail de reseña.';
COMMENT ON COLUMN comanda_local_settings.reservas_tpl_resena_subtitulo IS 'Subtítulo/cuerpo del mail de reseña.';
