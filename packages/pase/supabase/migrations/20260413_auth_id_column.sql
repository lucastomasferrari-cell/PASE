-- Agregar columna auth_id para linkear con Supabase Auth (auth.users.id)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS auth_id uuid;
