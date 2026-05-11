-- ═══════════════════════════════════════════════════════════════════════════
-- RPC crear_tenant_v2: versión nueva que NO toca passwords ni hashea.
--
-- Fecha:    2026-05-10
-- Por qué:  La RPC original `crear_tenant` (migration 202604281205) tiene
--           dos bugs descubiertos al intentar onboardear el primer tenant
--           de prueba (Lucas, 2026-05-10):
--
--   1. `digest(text, 'sha256')` no se encuentra porque pgcrypto está en
--      schema `extensions` y el RPC tiene SET search_path = public.
--      Resultado: el RPC crashea antes de crear nada.
--
--   2. Aún arreglando el search_path, el hash quedaría en
--      `usuarios.password` que es LEGACY (Supabase Auth tomó su lugar en
--      commit 3805ea7). El dueño creado no podría loguear porque
--      `auth.users` quedaría vacío.
--
-- Solución arquitectural:
--   - El endpoint serverless `api/crear-tenant.js` (con SUPABASE_SERVICE_KEY)
--     crea primero el `auth.users` via `auth.admin.createUser({email, password})`.
--   - Después llama a esta RPC v2 con el `p_auth_id` que devolvió.
--   - Si la RPC falla, el endpoint hace rollback eliminando el auth user.
--
-- Esta RPC NO maneja passwords. Solo crea las filas relacionales
-- (tenants, usuarios, locales, tenant_admins) atómicamente. El password
-- vive en `auth.users` donde Supabase Auth lo busca.
--
-- La RPC original `crear_tenant` queda en la DB como deprecated. Cualquier
-- código que la llame seguirá crasheando con el bug original — el frontend
-- (OnboardingTenant.tsx) se actualiza para usar el endpoint nuevo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crear_tenant_v2(
  p_nombre text,
  p_slug text,
  p_plan text,
  p_dueno_email text,
  p_dueno_nombre text,
  p_auth_id uuid,          -- UID de auth.users (creado por el endpoint serverless ANTES de llamar a este RPC)
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
  v_trial_ends timestamptz;
BEGIN
  -- 1. Validaciones de input.
  IF p_auth_id IS NULL THEN RAISE EXCEPTION 'AUTH_ID_REQUIRED'; END IF;
  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN RAISE EXCEPTION 'NOMBRE_REQUIRED'; END IF;
  IF p_slug IS NULL OR trim(p_slug) = '' THEN RAISE EXCEPTION 'SLUG_REQUIRED'; END IF;
  IF p_dueno_email IS NULL OR trim(p_dueno_email) = '' THEN RAISE EXCEPTION 'DUENO_EMAIL_REQUIRED'; END IF;
  IF p_local_nombre IS NULL OR trim(p_local_nombre) = '' THEN RAISE EXCEPTION 'LOCAL_NOMBRE_REQUIRED'; END IF;

  -- 2. Slug único.
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'SLUG_DUPLICATED';
  END IF;

  -- 3. Email único en usuarios.
  IF EXISTS (SELECT 1 FROM usuarios WHERE email = p_dueno_email) THEN
    RAISE EXCEPTION 'EMAIL_DUPLICATED';
  END IF;

  -- 4. auth_id único (defense-in-depth: nadie debería poder reusar un UID).
  IF EXISTS (SELECT 1 FROM usuarios WHERE auth_id = p_auth_id) THEN
    RAISE EXCEPTION 'AUTH_ID_DUPLICATED';
  END IF;

  -- 5. trial_ends_at si plan='trial'.
  v_trial_ends := CASE
    WHEN p_plan = 'trial' THEN now() + (p_trial_dias || ' days')::interval
    ELSE NULL
  END;

  -- 6. Crear tenant.
  INSERT INTO tenants (nombre, slug, plan, trial_ends_at, activo)
  VALUES (p_nombre, p_slug, COALESCE(p_plan, 'trial'), v_trial_ends, true)
  RETURNING id INTO v_tenant_id;

  -- 7. Crear usuario dueño linkeado a auth_id.
  --    password = '__supabase_auth_only__' es un placeholder legacy. La
  --    columna usuarios.password queda como NOT NULL (no se puede dropear
  --    sin migration aparte), pero el sistema activo es Supabase Auth.
  --    password_temporal=true para que el dueño cambie su password al primer
  --    login (UX). Si no quiere cambiarlo, igual funciona — el flag es
  --    UX, no security.
  INSERT INTO usuarios (
    nombre, email, password, rol, tenant_id, activo, password_temporal, auth_id
  )
  VALUES (
    p_dueno_nombre, p_dueno_email, '__supabase_auth_only__',
    'dueno', v_tenant_id, true, true, p_auth_id
  )
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
  VALUES ('tenants', 'CREAR_V2', jsonb_build_object(
    'tenant_id', v_tenant_id,
    'slug', p_slug,
    'dueno_id', v_usuario_id,
    'dueno_auth_id', p_auth_id,
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

-- Solo el service_role puede invocar v2 — los caller normales pasan por el
-- endpoint `api/crear-tenant.js` que valida superadmin antes de llamar.
-- Esto previene que un superadmin loguado en el browser invoque el RPC
-- directamente con un p_auth_id falso (saltándose la creación del auth user).
-- REVOKE de PUBLIC no alcanza: Supabase asigna GRANT EXECUTE a anon y
-- authenticated por default sobre cualquier función nueva, así que hay que
-- revocar de cada role explícitamente.
REVOKE ALL ON FUNCTION crear_tenant_v2(text, text, text, text, text, uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION crear_tenant_v2(text, text, text, text, text, uuid, text, text, int) TO service_role;

-- Comentario para que `crear_tenant` (vieja) quede flagueada como deprecated
-- sin dropearla (puede haber código legacy que la llame y queremos error
-- claro, no NULL pointer).
COMMENT ON FUNCTION crear_tenant(text, text, text, text, text, text, text, text, int) IS
  'DEPRECATED 2026-05-10 — usa digest() que crashea por search_path. Usar el endpoint api/crear-tenant.js que llama crear_tenant_v2. No remover sin verificar callers.';
