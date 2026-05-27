-- =============================================================================
-- F2D cleanup (post-auditoría): borrar hashes SHA-256 legacy en usuarios.password
-- =============================================================================
-- El sprint F2 eliminó el SHA-256 client-side en Config.tsx + Usuarios.tsx.
-- Login.tsx ya solo usa Supabase Auth desde hace meses. Sin embargo, 15 filas
-- de `usuarios.password` conservaban el hash SHA-256 viejo como deuda.
--
-- Vector: si la tabla `usuarios` se filtrara (RLS leak, dump, etc.), 15
-- hashes sin sal serían rompibles en segundos con rainbow tables.
-- Mitigación: reemplazar el hash por el placeholder `__supabase_auth_only__`.
-- NO se requiere reset del password real — Supabase Auth (Argon2id) sigue
-- siendo la única fuente para validar login.
--
-- Verificación previa: los 15 users tienen auth_id NOT NULL (confirmado live)
-- → todos tienen su password "vivo" en Supabase Auth. No quedan logins legacy.
-- =============================================================================

BEGIN;

UPDATE usuarios
   SET password = '__supabase_auth_only__'
 WHERE password IS NOT NULL
   AND password != '__supabase_auth_only__'
   AND auth_id IS NOT NULL;

-- Smoke check
DO $smoke$
DECLARE v_remaining int;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM usuarios
   WHERE password IS NOT NULL
     AND password != '__supabase_auth_only__'
     AND auth_id IS NOT NULL;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % users todavía tienen SHA-256 legacy', v_remaining;
  END IF;
  RAISE NOTICE 'SMOKE OK: cero SHA-256 legacy en usuarios.password';
END $smoke$;

COMMIT;
