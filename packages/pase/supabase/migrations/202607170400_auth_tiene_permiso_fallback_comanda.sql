-- ============================================================
-- 202607170400_auth_tiene_permiso_fallback_comanda.sql
-- Bug: 22 policies RLS de tablas COMANDA (items, canales, mesas,
-- ventas_pos, movimientos_caja, tax_rates, kds_tokens, modifier_groups,
-- item_precios_canal, medios_cobro, turnos_caja, combo_componentes,
-- item_grupos, item_modifier_groups, comanda_local_settings,
-- menu_qr_tokens, reservas_combinaciones, recetas_versiones, y las 4
-- ventas_pos_*) usan `auth_tiene_permiso('comanda.*')`. Esa función solo
-- consulta usuario_permisos (PASE), no comanda_usuario_permisos ni
-- rol_pos_permisos. Users PASE-encargado/cajero + acceso COMANDA (ej. Camilo)
-- tienen los slugs comanda.* en comanda_usuario_permisos pero no en
-- usuario_permisos → toda escritura POS les daba
-- "new row violates row-level security policy".
--
-- Fix aditivo: para slugs con prefix `comanda.`, la función además consulta
-- comanda_usuario_permisos + rol_pos_permisos (mismo path que
-- comanda_auth_tiene_permiso). Comportamiento para slugs PASE queda idéntico.
--
-- Contexto: Camilo (usuarios.id=10, encargado + rol_pos='cajero') reportó
-- 17-jul el error al crear un item. Ver [[project_comanda_permisos_camilo_rls_17_jul]].
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.auth_tiene_permiso(p_slug text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_user RECORD;
  v_via_rol BOOLEAN;
  v_via_legacy BOOLEAN;
  v_comanda_uid uuid;
  v_comanda_rol text;
  v_via_comanda BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;

  IF auth_es_superadmin() THEN RETURN true; END IF;

  -- ── Path PASE (comportamiento previo) ──────────────────────────────
  SELECT id, rol, rol_id, activo INTO v_user
  FROM usuarios WHERE auth_id = v_uid LIMIT 1;

  IF v_user.id IS NOT NULL AND v_user.activo THEN
    IF v_user.rol IN ('dueno', 'admin') THEN RETURN true; END IF;

    IF v_user.rol_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM rol_permisos
        WHERE rol_id = v_user.rol_id AND modulo_slug = p_slug
      ) INTO v_via_rol;
      IF v_via_rol THEN RETURN true; END IF;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM usuario_permisos
      WHERE usuario_id = v_user.id AND modulo_slug = p_slug
    ) INTO v_via_legacy;
    IF v_via_legacy THEN RETURN true; END IF;
  END IF;

  -- ── Path COMANDA (NUEVO 17-jul) ─────────────────────────────────────
  -- Solo se activa para slugs con prefix `comanda.`. Los slugs de PASE
  -- (caja, gastos, compras, etc.) NO llegan acá — su lógica quedó igual.
  IF p_slug LIKE 'comanda.%' THEN
    SELECT id, rol_pos INTO v_comanda_uid, v_comanda_rol
    FROM comanda_usuarios
    WHERE auth_id = v_uid AND activo = true
    LIMIT 1;

    IF v_comanda_uid IS NOT NULL THEN
      -- rol_pos='admin' = bypass total del path COMANDA (mismo criterio
      -- que comanda_auth_tiene_permiso).
      IF v_comanda_rol = 'admin' THEN RETURN true; END IF;

      SELECT EXISTS(
        SELECT 1 FROM comanda_usuario_permisos
        WHERE comanda_usuario_id = v_comanda_uid AND modulo_slug = p_slug
      ) INTO v_via_comanda;
      IF v_via_comanda THEN RETURN true; END IF;

      SELECT EXISTS(
        SELECT 1 FROM rol_pos_permisos
        WHERE rol_pos = v_comanda_rol AND slug = p_slug AND activo = true
      ) INTO v_via_comanda;
      IF v_via_comanda THEN RETURN true; END IF;
    END IF;
  END IF;

  RETURN false;
END;
$function$;

COMMIT;
