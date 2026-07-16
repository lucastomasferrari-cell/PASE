-- Roles del POS (PIN) editables desde Accesos + seed de límites sensatos.
--
-- `rol_pos_permisos` mapea rol_pos (cajero/bartender/encargado/manager/dueno) →
-- slugs de permisos. Lo lee usePermiso de COMANDA para el empleado del PIN.
--
-- ⚠️ DEUDA MULTI-TENANT: la tabla es GLOBAL (sin tenant_id) → estos roles se
-- comparten entre todos los tenants. Aceptable mientras Neko es el único
-- cliente real. Cuando haya varios, agregar tenant_id + scoping en la RPC y en
-- usePermiso (leer los del tenant con fallback a los globales).

-- 1) RPC para editar (dueño/admin, no solo superadmin como la RLS directa).
CREATE OR REPLACE FUNCTION public.fn_set_rol_pos_permisos(p_rol_pos text, p_slugs text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth_tenant_id() IS NULL THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_es_superadmin()) THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_rol_pos NOT IN ('cajero', 'bartender', 'encargado', 'manager', 'dueno') THEN
    RAISE EXCEPTION 'ROL_POS_INVALIDO';
  END IF;

  DELETE FROM rol_pos_permisos WHERE rol_pos = p_rol_pos;
  IF array_length(p_slugs, 1) IS NOT NULL THEN
    INSERT INTO rol_pos_permisos (rol_pos, slug, activo)
    SELECT p_rol_pos, s, true FROM unnest(p_slugs) AS s;
  END IF;

  RETURN jsonb_build_object('rol_pos', p_rol_pos, 'slugs', COALESCE(array_length(p_slugs, 1), 0));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_set_rol_pos_permisos(text, text[]) TO authenticated;

-- 2) Seed de límites sensatos por rol (reemplaza lo viejo). dueno queda '*'.
--    Sin efecto en el POS en vivo hoy (el terminal entra con la cuenta del
--    local, que es admin y bypassa) — deja los defaults listos para cuando se
--    active el gateo por PIN.
DELETE FROM rol_pos_permisos WHERE rol_pos IN ('cajero', 'bartender', 'encargado', 'manager');

INSERT INTO rol_pos_permisos (rol_pos, slug, activo)
SELECT r.rol_pos, s.slug, true
FROM (VALUES
  -- Cajero: cobra, abre/cierra su caja, ve menú y reportes básicos.
  ('cajero', 'comanda.ventas.cobrar'),
  ('cajero', 'comanda.caja.abrir'),
  ('cajero', 'comanda.caja.cerrar'),
  ('cajero', 'comanda.catalogo.ver'),
  ('cajero', 'comanda.reportes.ver'),
  -- Bartender: como cajero de barra (sin reportes).
  ('bartender', 'comanda.ventas.cobrar'),
  ('bartender', 'comanda.caja.abrir'),
  ('bartender', 'comanda.caja.cerrar'),
  ('bartender', 'comanda.catalogo.ver'),
  -- Encargado: gestiona turno/mesas, anula y descuenta.
  ('encargado', 'comanda.ventas.cobrar'),
  ('encargado', 'comanda.ventas.descuento'),
  ('encargado', 'comanda.ventas.anular'),
  ('encargado', 'comanda.caja.abrir'),
  ('encargado', 'comanda.caja.cerrar'),
  ('encargado', 'comanda.caja.movimientos'),
  ('encargado', 'comanda.caja.ver_esperado_cierre'),
  ('encargado', 'comanda.salon.editar'),
  ('encargado', 'comanda.mesas.gestionar'),
  ('encargado', 'comanda.catalogo.ver'),
  ('encargado', 'comanda.reportes.ver'),
  ('encargado', 'comanda.pagos.ver'),
  ('encargado', 'comanda.empleados.ver'),
  ('encargado', 'comanda.clientes.ver'),
  -- Manager: casi todo lo operativo, incluye reembolso/reabrir y editar catálogo.
  ('manager', 'comanda.ventas.cobrar'),
  ('manager', 'comanda.ventas.descuento'),
  ('manager', 'comanda.ventas.anular'),
  ('manager', 'comanda.ventas.refund'),
  ('manager', 'comanda.ventas.reopen'),
  ('manager', 'comanda.caja.abrir'),
  ('manager', 'comanda.caja.cerrar'),
  ('manager', 'comanda.caja.movimientos'),
  ('manager', 'comanda.caja.ver_esperado_cierre'),
  ('manager', 'comanda.salon.editar'),
  ('manager', 'comanda.mesas.gestionar'),
  ('manager', 'comanda.catalogo.ver'),
  ('manager', 'comanda.catalogo.editar'),
  ('manager', 'comanda.reportes.ver'),
  ('manager', 'comanda.pagos.ver'),
  ('manager', 'comanda.pagos.editar'),
  ('manager', 'comanda.empleados.ver'),
  ('manager', 'comanda.empleados.editar_pos'),
  ('manager', 'comanda.clientes.ver'),
  ('manager', 'comanda.clientes.editar'),
  ('manager', 'comanda.tienda.aprobar'),
  ('manager', 'comanda.audit.ver'),
  ('manager', 'comanda.config.editar')
) AS s(rol_pos, slug)
JOIN (VALUES ('cajero'), ('bartender'), ('encargado'), ('manager')) AS r(rol_pos)
  ON r.rol_pos = s.rol_pos;

NOTIFY pgrst, 'reload schema';
