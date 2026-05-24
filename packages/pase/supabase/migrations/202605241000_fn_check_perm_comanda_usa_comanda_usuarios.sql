-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint COMANDA Autónomo — Fase 4 (gap fix)
--
-- Bug descubierto 24-may noche: fn_check_perm_comanda (la función que
-- chequea permisos en TODAS las RPCs de COMANDA — fn_cobrar_venta_comanda,
-- fn_aplicar_descuento_comanda, fn_modificar_precio_item, etc.) seguía
-- leyendo `usuario_permisos` de PASE.
--
-- Resultado: aunque el dueño de Neko le marque "descuento" a Camilo en la
-- pantalla nueva /empleados/usuarios-pos (que escribe en
-- comanda_usuario_permisos), al operar las RPCs lo siguen ignorando
-- porque chequean contra los permisos PASE de Camilo.
--
-- Fix: fn_check_perm_comanda ahora usa comanda_auth_tiene_permiso (el
-- helper nuevo que lee comanda_usuario_permisos + rol_pos='admin' bypass).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_check_perm_comanda(p_slug TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_es_superadmin BOOLEAN;
  v_tiene BOOLEAN;
BEGIN
  -- Superadmin siempre puede (cross-tenant maintenance).
  SELECT auth_es_superadmin() INTO v_es_superadmin;
  IF v_es_superadmin THEN RETURN true; END IF;

  -- El resto: chequea contra comanda_usuario_permisos.
  -- comanda_auth_tiene_permiso:
  --   - retorna true si rol_pos='admin' (bypass total).
  --   - retorna true si el slug está en sus comanda_usuario_permisos.
  --   - retorna false si el user NO tiene fila en comanda_usuarios (= sin
  --     acceso a COMANDA, no debería estar operando).
  SELECT comanda_auth_tiene_permiso(p_slug) INTO v_tiene;
  RETURN COALESCE(v_tiene, false);
END;
$$;

REVOKE ALL ON FUNCTION fn_check_perm_comanda(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_check_perm_comanda(TEXT) TO authenticated;

COMMENT ON FUNCTION fn_check_perm_comanda(TEXT) IS
  'Helper para RPCs de COMANDA. Refactor 24-may noche: ahora lee comanda_usuarios + comanda_usuario_permisos en lugar de usuarios+usuario_permisos de PASE. Superadmin bypassa (cross-tenant).';

NOTIFY pgrst, 'reload schema';
