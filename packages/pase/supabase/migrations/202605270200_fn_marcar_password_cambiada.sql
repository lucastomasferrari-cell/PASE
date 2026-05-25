-- ─────────────────────────────────────────────────────────────────────────
-- fn_marcar_password_cambiada — RPC defensiva para el flow ForcePasswordChange.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Cierra bug reportado por Lucas 27-may: cuando se crea un tenant nuevo y
-- el dueño nuevo entra por primera vez, le aparece /force-password-change.
-- Cuando pone la contraseña nueva y submit, "se queda cargando y no la
-- cambia".
--
-- Diagnóstico:
--   - Frontend hacía `db.auth.updateUser({password})` (Supabase Auth) +
--     `db.from("usuarios").update({password_temporal:false}).eq("id", id)`.
--   - Si el UPDATE de la fila se cuelga / falla silenciosamente, el usuario
--     queda en loop: cada vez que loguea, la app ve password_temporal=true
--     y lo mete a /force-password-change otra vez.
--   - Evidencia: Malita (id=43) loguea el 2026-05-20 con `last_sign_in_at`
--     en auth.users SETEADO → el auth.updateUser SÍ funcionó. Pero
--     `usuarios.password_temporal` quedó en TRUE → el segundo UPDATE
--     falló.
--
-- Solución:
--   - RPC SECURITY DEFINER que hace el UPDATE basado en auth.uid() del caller.
--   - No depende de RLS — bypassa los edge cases de policies complejas
--     evaluadas justo después de auth.updateUser (que dispara
--     USER_UPDATED event y puede invalidar caches).
--   - Devuelve OK rápido y no espera nada más.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_marcar_password_cambiada()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_id UUID := auth.uid();
  v_rows INT;
BEGIN
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  UPDATE usuarios
    SET password_temporal = FALSE
    WHERE auth_id = v_auth_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Si no matchea ninguna fila, el user logueado en Supabase Auth no tiene
  -- perfil en `usuarios`. Eso sería un bug de provisioning, no de password.
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'NO_PROFILE';
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_marcar_password_cambiada IS
  'Marca usuarios.password_temporal=FALSE para el user logueado. SECURITY '
  'DEFINER para evitar edge cases de RLS después de auth.updateUser. '
  'Llamada por ForcePasswordChange.tsx tras éxito de auth.updateUser.';

-- Garantizar que cualquier authenticated puede llamarla (chequea auth.uid()
-- internamente). NO se otorga a anon ni a service_role (no aplica caso).
REVOKE ALL ON FUNCTION fn_marcar_password_cambiada FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_marcar_password_cambiada TO authenticated;
