-- =============================================================================
-- F4C#9: fn_log_frontend_error — log errors del frontend a la DB
-- =============================================================================
-- Antes: 29 `console.error` solo viven en DevTools del browser del user.
-- Lucas no se entera de errors en producción salvo que el user abra un ticket.
-- ErrorBoundary capturaba crashes pero solo loguea a consola.
--
-- Decisión: NO crear endpoint serverless nuevo (Vercel Hobby al límite de 12).
-- En su lugar, RPC SECURITY DEFINER que el frontend invoca directo via
-- supabase-js. RLS auth nos da el user automáticamente.
--
-- Persiste en `auditoria` con accion='FRONTEND_ERROR' — encaja con el patrón
-- existente, sin tabla nueva.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_log_frontend_error(
  p_message text,
  p_stack text DEFAULT NULL,
  p_url text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_context jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_user integer;
  v_id bigint;
BEGIN
  -- Auth check — solo authenticated puede loguear.
  v_tenant := auth_tenant_id();
  v_user := auth_usuario_id();
  IF v_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  -- Truncar campos para evitar explosión de tabla.
  IF length(p_message) > 1000 THEN p_message := substring(p_message, 1, 1000) || '... [trunc]'; END IF;
  IF p_stack IS NOT NULL AND length(p_stack) > 5000 THEN p_stack := substring(p_stack, 1, 5000) || '... [trunc]'; END IF;
  IF p_url IS NOT NULL AND length(p_url) > 500 THEN p_url := substring(p_url, 1, 500); END IF;

  INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
  VALUES (
    'frontend',
    'FRONTEND_ERROR',
    jsonb_build_object(
      'message', p_message,
      'stack', p_stack,
      'url', p_url,
      'user_agent', p_user_agent,
      'context', p_context,
      'usuario_id', v_user,
      'reported_at', now()
    )::text,
    now(),
    v_tenant
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('logged', true, 'auditoria_id', v_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_log_frontend_error(text, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_log_frontend_error(text, text, text, text, jsonb) TO authenticated, service_role;

-- Smoke
DO $smoke$
DECLARE v_n int;
BEGIN
  SELECT COUNT(*) INTO v_n FROM pg_proc WHERE proname = 'fn_log_frontend_error';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE FAIL'; END IF;
  RAISE NOTICE 'SMOKE OK: fn_log_frontend_error creada';
END $smoke$;

COMMIT;
