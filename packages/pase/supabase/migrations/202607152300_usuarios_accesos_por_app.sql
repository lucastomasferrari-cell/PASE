-- Accesos por app (Fase 1 del acordeón por-app en Accesos → Personas).
-- Guarda, por app del ecosistema, los locales asignados a esa persona.
-- Forma: { "comanda": {"locales":[3]}, "mesa": {"locales":[1,2]}, ... }.
--
-- PASE sigue usando usuario_locales + usuario_permisos (es el enforcement
-- actual). Esta columna captura la config POR APP de las demás apps
-- (COMANDA/MESA/Habitué); cada app la irá respetando a medida que la lea
-- (fases siguientes). Aditiva y segura: columna nueva, default '{}'.
ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS accesos_por_app JSONB NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
