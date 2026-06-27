-- Bot Instagram: guardar el @usuario de cada cliente para mostrarlo en el inbox.
--
-- Antes ig_clientes solo tenía `nombre` (display name, opcional) + `igsid`
-- (el ID numérico interno de Instagram). El inbox mostraba el IGSID cuando no
-- había nombre → "no se ven los usuarios". Ahora guardamos también el @username
-- (handle), que se trae del perfil vía Graph API (meta.js obtenerPerfil).
--
-- Aditiva y segura. La RLS existente de ig_clientes ya cubre la columna nueva.
ALTER TABLE ig_clientes ADD COLUMN IF NOT EXISTS ig_username text;
