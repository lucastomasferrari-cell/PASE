-- ─────────────────────────────────────────────────────────────────────────
-- BUG REAL DEL PRODUCTO: auth_tenant_id() no funciona para cajeros
-- solo-COMANDA (creados via API auth-admin).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Síntoma E2E test 32: cajero limitado intenta abrir mesa →
--   "null value in column tenant_id of relation ventas_pos
--    violates not-null constraint"
--
-- Síntoma producción (no detectado todavía pero existe): cualquier cajero
-- creado por Anto/Lucas vía PASE → Usuarios COMANDA → crear desde cero
-- (sin haber existido en PASE) no podría hacer NADA en COMANDA porque
-- todas las RPCs usan auth_tenant_id() que retorna NULL para él. Hasta
-- ahora venían "funcionando" solo los users que ALSO existen en PASE
-- (que ese sí tiene tenant en JWT).
--
-- ## Fix
--
-- auth_tenant_id() busca en `usuarios` (PASE). Agregar fallback a
-- `comanda_usuarios` para que también encuentre el tenant de cajeros
-- solo-COMANDA. COALESCE retorna el primer no-null.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT tenant_id FROM usuarios
      WHERE auth_id = auth.uid() AND activo LIMIT 1),
    (SELECT tenant_id FROM comanda_usuarios
      WHERE auth_id = auth.uid() AND activo LIMIT 1)
  );
$function$;

COMMENT ON FUNCTION public.auth_tenant_id IS
  'Retorna el tenant_id del user logueado. Busca primero en usuarios (PASE), '
  'fallback a comanda_usuarios (COMANDA-only). Fix 29-may: antes solo miraba '
  'usuarios → cajeros solo-COMANDA tenían NULL → todas las RPCs que insertan '
  'con tenant_id fallaban con NOT NULL violation.';
