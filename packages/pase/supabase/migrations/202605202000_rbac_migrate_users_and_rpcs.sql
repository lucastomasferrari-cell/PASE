-- ═══════════════════════════════════════════════════════════════════════════
-- RBAC fase 2: mapeo de usuarios existentes + RPCs CRUD de roles
--
-- 1. Mapea cada usuario activo al rol del sistema que mejor coincida con
--    sus permisos actuales. Si no calza con ninguno, le creamos un rol
--    custom para su tenant ("Custom — {nombre}").
-- 2. Define RPCs para que la UI maneje roles: crear, actualizar, asignar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Mapeo automático de usuarios ────────────────────────────────────────
-- Para cada usuario activo, intentamos asignarle un rol del sistema que
-- tenga EXACTAMENTE los mismos permisos que él tiene en usuario_permisos.
-- Si no hay match perfecto, creamos un rol custom.

DO $$
DECLARE
  v_user RECORD;
  v_user_perms TEXT[];
  v_rol_match UUID;
  v_rol_custom UUID;
  v_custom_slug TEXT;
BEGIN
  FOR v_user IN
    SELECT u.id, u.email, u.nombre, u.rol, u.tenant_id, u.rol_id
    FROM usuarios u
    WHERE u.activo = true
      AND u.rol_id IS NULL  -- no remapear los que ya tengan rol_id
  LOOP
    -- 1a. Superadmin no necesita rol asignado (tiene bypass).
    IF v_user.rol = 'superadmin' THEN CONTINUE; END IF;

    -- 1b. Si el rol legacy es 'dueno' o 'admin', le damos rol Dueño.
    IF v_user.rol IN ('dueno', 'admin') THEN
      SELECT id INTO v_rol_match FROM roles WHERE slug = 'dueno' AND tenant_id IS NULL;
      UPDATE usuarios SET rol_id = v_rol_match WHERE id = v_user.id;
      RAISE NOTICE 'User % (%, %) → Dueño', v_user.nombre, v_user.email, v_user.rol;
      CONTINUE;
    END IF;

    -- 1c. Encargado y otros: comparar sus permisos con los de los roles
    -- del sistema. Match exacto = mismo set de permisos.
    SELECT array_agg(modulo_slug ORDER BY modulo_slug) INTO v_user_perms
    FROM usuario_permisos WHERE usuario_id = v_user.id;
    v_user_perms := COALESCE(v_user_perms, ARRAY[]::TEXT[]);

    -- Buscar rol del sistema cuyo set de permisos sea idéntico.
    SELECT r.id INTO v_rol_match
    FROM roles r
    WHERE r.tenant_id IS NULL
      AND r.es_sistema = true
      AND r.slug != 'dueno'  -- ya cubierto arriba
      AND (
        SELECT array_agg(modulo_slug ORDER BY modulo_slug)
        FROM rol_permisos WHERE rol_id = r.id
      ) = v_user_perms
    LIMIT 1;

    IF v_rol_match IS NOT NULL THEN
      UPDATE usuarios SET rol_id = v_rol_match WHERE id = v_user.id;
      RAISE NOTICE 'User % (%) → rol del sistema (match exacto)', v_user.nombre, v_user.email;
    ELSE
      -- No hay match: creamos rol custom con sus permisos actuales.
      v_custom_slug := 'custom_' || lower(regexp_replace(v_user.nombre, '[^a-zA-Z0-9]+', '_', 'g')) || '_' || substring(v_user.id::text, 1, 6);

      INSERT INTO roles (tenant_id, slug, nombre, descripcion, es_sistema)
      VALUES (
        v_user.tenant_id,
        v_custom_slug,
        'Custom — ' || v_user.nombre,
        'Rol custom generado del set de permisos viejo de ' || v_user.nombre || '. Editable en Equipo → Roles.',
        false
      )
      RETURNING id INTO v_rol_custom;

      -- Copiar sus permisos al nuevo rol.
      INSERT INTO rol_permisos (rol_id, modulo_slug)
      SELECT v_rol_custom, modulo_slug FROM usuario_permisos WHERE usuario_id = v_user.id;

      UPDATE usuarios SET rol_id = v_rol_custom WHERE id = v_user.id;
      RAISE NOTICE 'User % (%) → rol custom % (% permisos)',
        v_user.nombre, v_user.email, v_custom_slug, array_length(v_user_perms, 1);
    END IF;
  END LOOP;
END $$;

-- ─── 2. RPCs CRUD de roles ──────────────────────────────────────────────────
-- crear_rol: dueño/admin crea un rol custom en su tenant.
CREATE OR REPLACE FUNCTION crear_rol(
  p_nombre TEXT,
  p_descripcion TEXT,
  p_permisos TEXT[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := auth_tenant_id();
  v_rol_id UUID;
  v_slug TEXT;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  IF p_nombre IS NULL OR length(trim(p_nombre)) = 0 THEN RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;

  v_slug := 'custom_' || lower(regexp_replace(p_nombre, '[^a-zA-Z0-9]+', '_', 'g')) || '_' || substring(gen_random_uuid()::text, 1, 6);

  INSERT INTO roles (tenant_id, slug, nombre, descripcion, es_sistema)
  VALUES (v_tenant, v_slug, trim(p_nombre), p_descripcion, false)
  RETURNING id INTO v_rol_id;

  IF p_permisos IS NOT NULL AND array_length(p_permisos, 1) > 0 THEN
    INSERT INTO rol_permisos (rol_id, modulo_slug)
    SELECT v_rol_id, unnest(p_permisos)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('rol_id', v_rol_id, 'slug', v_slug);
END;
$$;

-- actualizar_rol: cambia nombre/descripción/permisos. Funciona tanto para
-- roles del sistema (solo permisos editables — nombre+slug+es_sistema no
-- cambian) como custom.
CREATE OR REPLACE FUNCTION actualizar_rol(
  p_rol_id UUID,
  p_nombre TEXT DEFAULT NULL,
  p_descripcion TEXT DEFAULT NULL,
  p_permisos TEXT[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol RECORD;
  v_tenant UUID := auth_tenant_id();
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  SELECT * INTO v_rol FROM roles WHERE id = p_rol_id;
  IF v_rol IS NULL THEN RAISE EXCEPTION 'ROL_NO_ENCONTRADO'; END IF;

  -- Roles globales del sistema solo los puede tocar el superadmin (afecta
  -- a todos los tenants). Por ahora bloqueamos edición de roles globales
  -- desde la UI normal.
  IF v_rol.tenant_id IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'ROL_SISTEMA_NO_EDITABLE: pedile al superadmin que ajuste el rol % o cloná y modificá', v_rol.slug;
  END IF;

  IF v_rol.tenant_id IS NOT NULL AND v_rol.tenant_id != v_tenant THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: rol de otro tenant';
  END IF;

  -- Actualizar campos opcionales.
  IF p_nombre IS NOT NULL AND length(trim(p_nombre)) > 0 AND NOT v_rol.es_sistema THEN
    UPDATE roles SET nombre = trim(p_nombre) WHERE id = p_rol_id;
  END IF;
  IF p_descripcion IS NOT NULL THEN
    UPDATE roles SET descripcion = p_descripcion WHERE id = p_rol_id;
  END IF;

  -- Si vienen permisos, reemplazamos el set completo.
  IF p_permisos IS NOT NULL THEN
    DELETE FROM rol_permisos WHERE rol_id = p_rol_id;
    IF array_length(p_permisos, 1) > 0 THEN
      INSERT INTO rol_permisos (rol_id, modulo_slug)
      SELECT p_rol_id, unnest(p_permisos)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- eliminar_rol: solo roles custom sin usuarios asignados.
CREATE OR REPLACE FUNCTION eliminar_rol(p_rol_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol RECORD;
  v_count INT;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  SELECT * INTO v_rol FROM roles WHERE id = p_rol_id;
  IF v_rol IS NULL THEN RAISE EXCEPTION 'ROL_NO_ENCONTRADO'; END IF;
  IF v_rol.es_sistema THEN RAISE EXCEPTION 'ROL_SISTEMA_NO_ELIMINABLE'; END IF;
  IF v_rol.tenant_id != auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: rol de otro tenant';
  END IF;

  SELECT count(*) INTO v_count FROM usuarios WHERE rol_id = p_rol_id AND activo;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'ROL_EN_USO: % usuario(s) tienen este rol. Reasignalos antes de borrar.', v_count;
  END IF;

  DELETE FROM roles WHERE id = p_rol_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- asignar_rol_a_usuario: el dueño asigna un rol a un usuario.
CREATE OR REPLACE FUNCTION asignar_rol_a_usuario(
  p_usuario_id INT,
  p_rol_id UUID
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user RECORD;
  v_rol RECORD;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  SELECT * INTO v_user FROM usuarios WHERE id = p_usuario_id;
  IF v_user IS NULL THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;
  IF v_user.tenant_id != auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: usuario de otro tenant';
  END IF;

  SELECT * INTO v_rol FROM roles WHERE id = p_rol_id;
  IF v_rol IS NULL THEN RAISE EXCEPTION 'ROL_NO_ENCONTRADO'; END IF;
  -- Rol debe ser global O del mismo tenant.
  IF v_rol.tenant_id IS NOT NULL AND v_rol.tenant_id != auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: rol de otro tenant';
  END IF;

  UPDATE usuarios SET rol_id = p_rol_id WHERE id = p_usuario_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Grants
GRANT EXECUTE ON FUNCTION crear_rol(TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION actualizar_rol(UUID, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION eliminar_rol(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION asignar_rol_a_usuario(INT, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
