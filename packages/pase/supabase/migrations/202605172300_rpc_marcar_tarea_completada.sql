-- ═══════════════════════════════════════════════════════════════════════════
-- RPC marcar_tarea_completada — fix RLS bug del widget Tareas Pineadas
-- Sesión 2026-05-17
--
-- Bug encontrado: el widget TareasPineadasWidget muestra el botón
-- "Marcar como completada" a CUALQUIER usuario que ve una tarea pineada
-- (las propias o las de su rol). Pero la policy `pinned_modify` de la
-- tabla `dashboard_pinned_notes` solo permite UPDATE a dueño/admin/superadmin.
--
-- Consecuencia: un encargado clickea "completar", el UPDATE viaja a Supabase,
-- RLS lo bloquea SILENCIOSAMENTE (0 rows affected, sin error), el widget
-- recarga y la tarea sigue pendiente. UX rota.
--
-- Fix: RPC SECURITY DEFINER que el target_usuario (o cualquiera con el
-- target_rol) puede invocar. Validación en las primeras 5 líneas (regla C11).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION marcar_tarea_completada(p_nota_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id INTEGER := auth_usuario_id();
  v_caller_rol TEXT;
  v_nota RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  SELECT rol INTO v_caller_rol FROM usuarios WHERE id = v_caller_id;

  SELECT id, tenant_id, target_usuario_id, target_rol, es_tarea, completada_at
    INTO v_nota
    FROM dashboard_pinned_notes
    WHERE id = p_nota_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOTA_INEXISTENTE';
  END IF;

  IF v_nota.tenant_id <> auth_tenant_id() THEN
    RAISE EXCEPTION 'NOTA_OTRO_TENANT';
  END IF;

  IF NOT v_nota.es_tarea THEN
    RAISE EXCEPTION 'NO_ES_TAREA';
  END IF;

  IF v_nota.completada_at IS NOT NULL THEN
    -- Idempotente: si ya está completada, no hacemos nada.
    RETURN;
  END IF;

  -- Authorization: el caller debe ser el target_usuario o tener el target_rol.
  -- Dueño/admin siempre puede.
  IF NOT (
    auth_es_dueno_o_admin()
    OR v_nota.target_usuario_id = v_caller_id
    OR v_nota.target_rol = v_caller_rol
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO_PARA_TAREA';
  END IF;

  UPDATE dashboard_pinned_notes
    SET completada_at = NOW(),
        completada_por = v_caller_id
    WHERE id = p_nota_id;
END;
$$;

REVOKE ALL ON FUNCTION marcar_tarea_completada(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marcar_tarea_completada(BIGINT) TO authenticated;

COMMENT ON FUNCTION marcar_tarea_completada(BIGINT) IS
  'Permite al target_usuario (o cualquiera con el target_rol) marcar una tarea pineada como completada. Bypassa pinned_modify policy que solo deja a dueño/admin. Auth-checked. Idempotente.';

NOTIFY pgrst, 'reload schema';
