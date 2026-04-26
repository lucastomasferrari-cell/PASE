-- ═══════════════════════════════════════════════════════════════════════════
-- Cierra 4 policies abiertas (USING true / WITH CHECK true) en tablas hijas
-- que dejaban a cualquier usuario authenticated leer/escribir todo.
--
-- Patrón: heredar el scope de la tabla padre vía EXISTS, igual que
-- factura_items hoy (fi_scope_all en 20260423_rls_real_policies.sql).
--
-- Tablas:
--   factura_items_stock → facturas       via factura_id
--   remito_items        → remitos        via remito_id
--   rrhh_adelantos      → rrhh_empleados via empleado_id
--   mp_liquidaciones    → mp_credenciales via credencial_id
--                          (mp_credenciales es admin-only, así que
--                           mp_liquidaciones queda admin-only de facto —
--                           decisión consciente)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) factura_items_stock — scope vía facturas.local_id
DROP POLICY IF EXISTS "fis_auth_all" ON factura_items_stock;
CREATE POLICY "fis_scope_all" ON factura_items_stock FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM facturas f
    WHERE f.id = factura_items_stock.factura_id
      AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM facturas f
    WHERE f.id = factura_items_stock.factura_id
      AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles()))
  ));

-- 2) remito_items — scope vía remitos.local_id
DROP POLICY IF EXISTS "rmi_auth_all" ON remito_items;
CREATE POLICY "rmi_scope_all" ON remito_items FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM remitos r
    WHERE r.id = remito_items.remito_id
      AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM remitos r
    WHERE r.id = remito_items.remito_id
      AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles()))
  ));

-- 3) rrhh_adelantos — scope vía rrhh_empleados.local_id
DROP POLICY IF EXISTS "rrhh_ad_auth_all" ON rrhh_adelantos;
CREATE POLICY "rrhh_ad_scope_all" ON rrhh_adelantos FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM rrhh_empleados e
    WHERE e.id::text = rrhh_adelantos.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rrhh_empleados e
    WHERE e.id::text = rrhh_adelantos.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))
  ));

-- 4) mp_liquidaciones — scope vía mp_credenciales.local_id
-- mp_credenciales tiene policy mpc_admin_all (sólo dueño/admin la ven), así
-- que el EXISTS sólo matchea para dueño/admin. Decisión consciente:
-- mp_liquidaciones queda admin-only de facto. Encargados no-admin no acceden
-- a las liquidaciones MP aunque el local sea suyo.
-- Drop también mpl_scope_all si llegó a aplicarse en algún momento.
DROP POLICY IF EXISTS "mpl_auth_all" ON mp_liquidaciones;
DROP POLICY IF EXISTS "mpl_scope_all" ON mp_liquidaciones;
CREATE POLICY "mpl_scope_all" ON mp_liquidaciones FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM mp_credenciales c
    WHERE c.id = mp_liquidaciones.credencial_id
      AND (auth_es_dueno_o_admin() OR c.local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM mp_credenciales c
    WHERE c.id = mp_liquidaciones.credencial_id
      AND (auth_es_dueno_o_admin() OR c.local_id = ANY(auth_locales_visibles()))
  ));
