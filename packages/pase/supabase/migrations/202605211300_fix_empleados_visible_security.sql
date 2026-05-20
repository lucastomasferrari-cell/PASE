-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: vista v_rrhh_empleados_visible bypasseaba RLS
--
-- Bug reportado Lucas 2026-05-20: estando parado en "Cantina René" (que no
-- tiene empleados propios ni cesiones), en Gastos > Empleados aparecían
-- los 54 empleados de TODOS los locales de Neko (Villa Crespo, Belgrano,
-- Devoto, Maneki, Local Prueba, Local Prueba 2).
--
-- Causa raíz: la vista se creó sin `security_invoker = on`, así que en
-- Postgres corre como SECURITY DEFINER (default), saltando la RLS de
-- rrhh_empleados. Eso era un agujero más grave de lo reportado — podría
-- exponer empleados de OTROS tenants también.
--
-- Fix:
--   1. ALTER VIEW WITH (security_invoker = on) — respeta RLS del caller.
--   2. Filtro WHERE explícito sobre auth_locales_visibles() — limita
--      al universo de locales que el caller puede ver. Defense-in-depth.
--
-- El filtro por LOCAL ACTIVO (no por todos los locales visibles) lo
-- hace el frontend con un .filter post-fetch, porque la noción de
-- "local activo" vive en el sidebar de la UI y no en el JWT.
-- ═══════════════════════════════════════════════════════════════════════════

-- security_invoker = on hace que la vista respete RLS del usuario que la
-- consulta, en vez de las del owner que la creó.
ALTER VIEW v_rrhh_empleados_visible SET (security_invoker = on);

-- Recreamos la vista agregando el filtro defensivo extra.
-- (Nota: ya teníamos sec_invoker en este punto; los WHERE actúan en cascada
--  con la RLS de rrhh_empleados, no la reemplazan).
CREATE OR REPLACE VIEW v_rrhh_empleados_visible
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.tenant_id,
  e.local_id AS local_principal_id,
  e.nombre,
  e.activo,
  ARRAY(
    SELECT rel.local_id FROM rrhh_empleado_locales rel
     WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL
     ORDER BY rel.es_principal DESC, rel.local_id
  ) AS locales_ids,
  (SELECT COUNT(*) FROM rrhh_empleado_locales rel
    WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL
      AND rel.es_principal = FALSE) AS cantidad_cesiones,
  e.creado_at AS created_at,
  e.fecha_inicio
FROM rrhh_empleados e
WHERE
  -- Activos o egresados recientes (último 90d) — para que el frontend
  -- vea los últimos liquidados aunque ya no estén activos.
  (e.fecha_egreso IS NULL OR e.fecha_egreso >= CURRENT_DATE - INTERVAL '90 days')
  -- Defense-in-depth: el caller solo ve empleados que tienen al menos UNO
  -- de sus locales en los visibles para él. Esto NO reemplaza el filtro
  -- por LOCAL ACTIVO (eso lo hace el frontend); es protección extra para
  -- usuarios encargados que no son dueño/admin.
  AND (
    auth_es_dueno_o_admin()
    OR EXISTS (
      SELECT 1 FROM rrhh_empleado_locales rel
      WHERE rel.empleado_id = e.id
        AND rel.deleted_at IS NULL
        AND rel.local_id = ANY(auth_locales_visibles())
    )
  );

GRANT SELECT ON v_rrhh_empleados_visible TO authenticated;

NOTIFY pgrst, 'reload schema';
