-- 202606221900_rls_empleados_cesion_select.sql
-- Completa el diseño de empleados multi-local (202605204100): un encargado debe
-- poder VER a un empleado cesionado a UNO DE SUS locales, aunque el local
-- PRINCIPAL del empleado no le sea visible. La RLS original de rrhh_empleados
-- solo miraba el local principal (rrhh_empleados.local_id), así que los
-- cesionados no aparecían para encargados sin visibilidad del local de origen
-- (Lucas 22-jun: que Anto vea los cesionados).
--
-- Política PERMISIVA adicional, SOLO para SELECT (se OR-ea con la existente).
-- Las escrituras (editar legajo, sueldo, etc.) siguen restringidas al local
-- principal por la política rrhh_empleados_mt (FOR ALL) — un encargado ve al
-- cesionado pero no lo edita.
CREATE POLICY rrhh_empleados_sel_cesion ON rrhh_empleados
  FOR SELECT TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM rrhh_empleado_locales rel
      WHERE rel.empleado_id = rrhh_empleados.id
        AND rel.deleted_at IS NULL
        AND rel.local_id = ANY (auth_locales_visibles())
    )
  );
