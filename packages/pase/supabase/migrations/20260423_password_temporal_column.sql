-- Flag para forzar cambio de password en el primer login tras migración a Supabase Auth.
-- NULL/false = password normal. true = el usuario debe cambiarla antes de navegar.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_temporal boolean DEFAULT false;
