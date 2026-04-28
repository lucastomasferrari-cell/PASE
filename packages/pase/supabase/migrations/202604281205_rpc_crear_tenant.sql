-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — Etapa 6: RPC crear_tenant atómica.
--
-- Crea un nuevo tenant + primer dueño + primer local + tenant_admins en
-- una sola transacción. Solo invocable por superadmin (auth_es_superadmin()
-- TRUE). Caller no-superadmin → RAISE 'NOT_SUPERADMIN'.
--
-- Validaciones:
--   - slug único en tenants (RAISE 'SLUG_DUPLICATED').
--   - email único en usuarios (RAISE 'EMAIL_DUPLICATED').
--
-- Retorno: jsonb con los uuids generados.
--
-- NOTA sobre permisos del dueño: dueño/admin tienen bypass via
-- auth_es_dueno_o_admin(), no necesitan rows en usuario_permisos ni
-- usuario_locales. La UI también los trata como "ve todo" via getPermisos.
-- Por eso esta RPC NO inserta esas tablas.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crear_tenant(
  p_nombre text,
  p_slug text,
  p_plan text,
  p_dueno_email text,
  p_dueno_nombre text,
  p_dueno_password text,
  p_local_nombre text,
  p_local_direccion text DEFAULT NULL,
  p_trial_dias int DEFAULT 14
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_usuario_id integer;
  v_local_id integer;
  v_password_hash text;
  v_trial_ends timestamptz;
BEGIN
  -- 1. Solo superadmin puede crear tenants.
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NOT_SUPERADMIN';
  END IF;

  -- 2. Slug único.
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'SLUG_DUPLICATED';
  END IF;

  -- 3. Email único en usuarios.
  IF EXISTS (SELECT 1 FROM usuarios WHERE email = p_dueno_email) THEN
    RAISE EXCEPTION 'EMAIL_DUPLICATED';
  END IF;

  -- 4. trial_ends_at si plan='trial'.
  v_trial_ends := CASE
    WHEN p_plan = 'trial' THEN now() + (p_trial_dias || ' days')::interval
    ELSE NULL
  END;

  -- 5. Crear tenant.
  INSERT INTO tenants (nombre, slug, plan, trial_ends_at, activo)
  VALUES (p_nombre, p_slug, COALESCE(p_plan, 'trial'), v_trial_ends, true)
  RETURNING id INTO v_tenant_id;

  -- 6. Hash SHA-256 del password (igual que sha256() en frontend para login fallback).
  v_password_hash := encode(digest(p_dueno_password, 'sha256'), 'hex');

  -- 7. Crear usuario dueño con password_temporal=true (forzado a cambiar al login).
  INSERT INTO usuarios (nombre, email, password, rol, tenant_id, activo, password_temporal)
  VALUES (p_dueno_nombre, p_dueno_email, v_password_hash, 'dueno', v_tenant_id, true, true)
  RETURNING id INTO v_usuario_id;

  -- 8. Crear primer local del tenant.
  INSERT INTO locales (nombre, tenant_id)
  VALUES (p_local_nombre, v_tenant_id)
  RETURNING id INTO v_local_id;

  -- 9. Vincular dueño en tenant_admins.
  INSERT INTO tenant_admins (tenant_id, usuario_id, rol)
  VALUES (v_tenant_id, v_usuario_id, 'dueno');

  -- 10. Auditar.
  INSERT INTO auditoria (tabla, accion, detalle, tenant_id)
  VALUES ('tenants', 'CREAR', jsonb_build_object(
    'tenant_id', v_tenant_id,
    'slug', p_slug,
    'dueno_id', v_usuario_id,
    'local_id', v_local_id
  )::text, v_tenant_id);

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', v_tenant_id,
    'usuario_id', v_usuario_id,
    'local_id', v_local_id,
    'slug', p_slug,
    'plan', p_plan,
    'trial_ends_at', v_trial_ends
  );
END;
$$;

GRANT EXECUTE ON FUNCTION crear_tenant(text, text, text, text, text, text, text, text, int) TO authenticated;
