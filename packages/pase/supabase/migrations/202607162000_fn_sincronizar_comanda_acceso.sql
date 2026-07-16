-- Enganche por email PASE → COMANDA.
-- Cuando el dueño da acceso a COMANDA a una persona (con cuenta email de PASE)
-- desde Accesos, esta RPC crea/sincroniza su fila en `comanda_usuarios` (misma
-- auth por email) + sus `comanda_usuario_permisos` + locales + rol POS. Así el
-- login de COMANDA (que lee esas tablas) lo respeta de verdad.
--   p_activo=false → desactiva el comanda_usuario (bloquea login, reversible).
--   p_activo=true  → upsert + reemplaza permisos por p_permisos.
-- Seguridad: SECURITY DEFINER + chequeo dueño/admin del tenant (C11).
CREATE OR REPLACE FUNCTION public.fn_sincronizar_comanda_acceso(
  p_usuario_id integer,
  p_activo boolean,
  p_locales integer[] DEFAULT NULL,
  p_permisos text[] DEFAULT '{}',
  p_rol_pos text DEFAULT 'cajero'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_auth uuid;
  v_email text;
  v_nombre text;
  v_utenant uuid;
  v_cu uuid;
  v_locales integer[] := CASE WHEN p_locales IS NULL OR array_length(p_locales, 1) IS NULL THEN NULL ELSE p_locales END;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_es_superadmin()) THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_rol_pos NOT IN ('mozo', 'cajero', 'manager', 'admin') THEN RAISE EXCEPTION 'ROL_POS_INVALIDO'; END IF;

  SELECT auth_id, email, nombre, tenant_id INTO v_auth, v_email, v_nombre, v_utenant
    FROM usuarios WHERE id = p_usuario_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;
  IF v_utenant <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;

  -- Buscar el comanda_usuario ya existente (por email o por auth) en el tenant.
  SELECT id INTO v_cu FROM comanda_usuarios
   WHERE tenant_id = v_tenant AND (email = v_email OR (v_auth IS NOT NULL AND auth_id = v_auth))
   LIMIT 1;

  -- Revocar acceso: desactivar (reversible). Si no existe, no-op.
  IF NOT p_activo THEN
    IF v_cu IS NOT NULL THEN UPDATE comanda_usuarios SET activo = false WHERE id = v_cu; END IF;
    RETURN jsonb_build_object('comanda_usuario_id', v_cu, 'activo', false);
  END IF;

  -- Dar acceso: necesita auth (login de COMANDA es por auth_id).
  IF v_auth IS NULL THEN RAISE EXCEPTION 'USUARIO_SIN_AUTH'; END IF;

  IF v_cu IS NULL THEN
    INSERT INTO comanda_usuarios (auth_id, tenant_id, nombre, email, rol_pos, locales, activo)
    VALUES (v_auth, v_tenant, v_nombre, v_email, p_rol_pos, v_locales, true)
    RETURNING id INTO v_cu;
  ELSE
    UPDATE comanda_usuarios
       SET auth_id = v_auth, nombre = v_nombre, email = v_email,
           rol_pos = p_rol_pos, locales = v_locales, activo = true
     WHERE id = v_cu;
  END IF;

  -- Reemplazar los permisos por el set elegido.
  DELETE FROM comanda_usuario_permisos WHERE comanda_usuario_id = v_cu;
  IF array_length(p_permisos, 1) IS NOT NULL THEN
    INSERT INTO comanda_usuario_permisos (comanda_usuario_id, tenant_id, modulo_slug)
    SELECT v_cu, v_tenant, s FROM unnest(p_permisos) AS s
    ON CONFLICT (comanda_usuario_id, modulo_slug) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('comanda_usuario_id', v_cu, 'activo', true, 'permisos', COALESCE(array_length(p_permisos, 1), 0));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_sincronizar_comanda_acceso(integer, boolean, integer[], text[], text) TO authenticated;

NOTIFY pgrst, 'reload schema';
