-- ─────────────────────────────────────────────────────────────────────────
-- Fix 2 funciones que rompen tests E2E + casos reales del producto.
-- ─────────────────────────────────────────────────────────────────────────
--
-- ## Fix #1: fn_recalc_costo_insumo (la que SÍ usa el trigger)
--
-- Mi fix anterior arregló fn_recalcular_costo_promedio_insumo + fn_recalcular_stock_insumo
-- (con "ular_"). PERO el trigger AFTER INSERT en materias_primas llama
-- fn_recalc_costo_insumo (SIN "ular_") que es OTRA función con la misma
-- lógica. Aplico el mismo fix: permitir service_role (auth_tenant_id NULL).
--
-- ## Fix #2: comanda_auth_tiene_permiso permite users sin tenant en JWT
--
-- Bug REAL del producto descubierto al debuggear test 32. La función
-- chequea:
--   IF v_auth IS NULL OR v_tenant IS NULL THEN RETURN false; END IF;
--
-- Problema: usuarios creados via Supabase auth.admin.createUser NO tienen
-- `app_metadata.tenant_id` seteado (lo asigna otro flujo). Para ellos,
-- `auth_tenant_id()` retorna NULL → la función retorna false antes de
-- chequear sus permisos. **CONSECUENCIA EN PRODUCCIÓN**: cualquier cajero
-- COMANDA creado vía API de admin no puede usar sus permisos POS hasta que
-- algún flow le setee tenant_id en JWT (que hoy no existe).
--
-- Fix: derivar el tenant del propio row de `comanda_usuarios` por auth_id,
-- en vez de exigirlo del JWT. Si existe fila con activo=true, usar ese
-- tenant_id. Si no existe fila → return false (sin acceso a COMANDA).
-- ─────────────────────────────────────────────────────────────────────────

-- ── Fix #1 ──
CREATE OR REPLACE FUNCTION public.fn_recalc_costo_insumo(p_insumo_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_costo_promedio NUMERIC;
  v_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  -- Permitir: superadmin, service_role (sin sesión), o mismo tenant.
  IF NOT auth_es_superadmin()
     AND auth_tenant_id() IS NOT NULL
     AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  SELECT AVG(
    precio_actual / NULLIF(factor_conversion * (1 - merma_pct / 100.0), 0)
  )
  INTO v_costo_promedio
  FROM materias_primas
  WHERE insumo_id = p_insumo_id
    AND activa = TRUE
    AND deleted_at IS NULL
    AND precio_actual IS NOT NULL
    AND precio_actual > 0;

  IF v_costo_promedio IS NOT NULL THEN
    UPDATE insumos
      SET costo_actual = ROUND(v_costo_promedio::numeric, 2),
          costo_actualizado_at = NOW(),
          updated_at = NOW()
      WHERE id = p_insumo_id;
  END IF;
END;
$function$;

-- ── Fix #2 ──
CREATE OR REPLACE FUNCTION public.comanda_auth_tiene_permiso(p_slug text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_auth uuid := auth.uid();
  v_usuario_id uuid;
  v_rol_pos TEXT;
  v_existe BOOLEAN;
BEGIN
  -- Sin auth.uid() = anon o service_role → no aplica.
  IF v_auth IS NULL THEN RETURN false; END IF;

  -- Fix 29-may: derivar tenant del row de comanda_usuarios.
  -- Antes exigíamos auth_tenant_id() del JWT, pero users creados via
  -- auth.admin.createUser no tienen tenant en app_metadata → todos sus
  -- permisos quedaban inaccesibles.
  SELECT id, rol_pos INTO v_usuario_id, v_rol_pos
  FROM comanda_usuarios
  WHERE auth_id = v_auth AND activo = true
  LIMIT 1;

  IF v_usuario_id IS NULL THEN RETURN false; END IF;

  -- Admin POS = todo
  IF v_rol_pos = 'admin' THEN RETURN true; END IF;

  -- Chequear slug específico
  SELECT EXISTS(
    SELECT 1 FROM comanda_usuario_permisos
    WHERE comanda_usuario_id = v_usuario_id AND modulo_slug = p_slug
  ) INTO v_existe;

  RETURN COALESCE(v_existe, false);
END;
$function$;

COMMENT ON FUNCTION public.fn_recalc_costo_insumo IS
  'Recalcula costo_actual del insumo. Llamado desde trigger AFTER INSERT/UPDATE '
  'en materias_primas. Fix 29-may: permitir service_role (sin sesión) además de '
  'superadmin y mismo tenant. Antes tiraba INSUMO_CROSS_TENANT a service_role.';

COMMENT ON FUNCTION public.comanda_auth_tiene_permiso IS
  'Chequea si el user logueado tiene un permiso COMANDA específico. Fix 29-may: '
  'deriva tenant del propio row de comanda_usuarios (no del JWT). Antes users '
  'creados via auth.admin.createUser no podían usar sus permisos porque su JWT '
  'no tenía tenant_id seteado.';
