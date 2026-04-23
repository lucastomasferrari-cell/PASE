-- ═══════════════════════════════════════════════════════════════════════════
-- RLS defense-in-depth: aislamiento por local + admin bypass.
-- Reemplaza TODAS las policies abiertas (usuarios_anon_login, *_all, etc).
-- Cierra el agujero de "Table publicly accessible" reportado por Supabase.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. DROP TODAS las policies existentes en public schema (clean slate).
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- 2. Helpers SECURITY DEFINER — bypassean RLS para evitar recursión infinita.
CREATE OR REPLACE FUNCTION auth_usuario_id()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auth_es_dueno_o_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios WHERE auth_id = auth.uid() AND rol IN ('dueno','admin') AND activo
  );
$$;

CREATE OR REPLACE FUNCTION auth_locales_visibles()
RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth_es_dueno_o_admin() THEN NULL::integer[]
    ELSE COALESCE(
      (SELECT array_agg(ul.local_id) FROM usuario_locales ul WHERE ul.usuario_id = auth_usuario_id()),
      ARRAY[]::integer[]
    )
  END;
$$;

-- 3. ENABLE RLS en todas las tablas (idempotente).
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_permisos ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_locales ENABLE ROW LEVEL SECURITY;
ALTER TABLE locales ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE factura_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE gastos ENABLE ROW LEVEL SECURITY;
ALTER TABLE remitos ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE insumos ENABLE ROW LEVEL SECURITY;
ALTER TABLE recetas ENABLE ROW LEVEL SECURITY;
ALTER TABLE receta_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saldos_caja ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_credenciales ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE empleados ENABLE ROW LEVEL SECURITY;
ALTER TABLE empleado_archivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_empleados ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_novedades ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_liquidaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_valores_doble ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_historial_sueldos ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_documentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE rrhh_pagos_especiales ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja_efectivo ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_categorias ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='auditoria') THEN
    EXECUTE 'ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='mp_liquidaciones') THEN
    EXECUTE 'ALTER TABLE mp_liquidaciones ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_tipos_documento') THEN
    EXECUTE 'ALTER TABLE blindaje_tipos_documento ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_documentos') THEN
    EXECUTE 'ALTER TABLE blindaje_documentos ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- 4. Policies ─────────────────────────────────────────────────────────────────

-- usuarios: cada usuario ve su propia fila + dueno/admin ven todas.
-- UPDATE: el propio usuario (para password_temporal) y dueno/admin.
-- INSERT/DELETE: sólo dueno/admin.
CREATE POLICY "usuarios_select" ON usuarios FOR SELECT TO authenticated
  USING (auth_id = auth.uid() OR auth_es_dueno_o_admin());
CREATE POLICY "usuarios_self_update" ON usuarios FOR UPDATE TO authenticated
  USING (auth_id = auth.uid()) WITH CHECK (auth_id = auth.uid());
CREATE POLICY "usuarios_admin_insert" ON usuarios FOR INSERT TO authenticated
  WITH CHECK (auth_es_dueno_o_admin());
CREATE POLICY "usuarios_admin_update" ON usuarios FOR UPDATE TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());
CREATE POLICY "usuarios_admin_delete" ON usuarios FOR DELETE TO authenticated
  USING (auth_es_dueno_o_admin());

-- usuario_permisos / usuario_locales
CREATE POLICY "up_select" ON usuario_permisos FOR SELECT TO authenticated
  USING (usuario_id = auth_usuario_id() OR auth_es_dueno_o_admin());
CREATE POLICY "up_admin_write" ON usuario_permisos FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

CREATE POLICY "ul_select" ON usuario_locales FOR SELECT TO authenticated
  USING (usuario_id = auth_usuario_id() OR auth_es_dueno_o_admin());
CREATE POLICY "ul_admin_write" ON usuario_locales FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

-- locales: cualquier autenticado lee; admin escribe.
CREATE POLICY "locales_read" ON locales FOR SELECT TO authenticated USING (true);
CREATE POLICY "locales_admin_write" ON locales FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

-- Scope macro para tablas con local_id: admin ve todo; encargado ve sus locales.

-- movimientos
CREATE POLICY "mov_scope_all" ON movimientos FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- facturas
CREATE POLICY "fac_scope_all" ON facturas FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- factura_items: scope vía facturas
CREATE POLICY "fi_scope_all" ON factura_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM facturas f WHERE f.id = factura_items.factura_id
    AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM facturas f WHERE f.id = factura_items.factura_id
    AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles()))));

-- ventas
CREATE POLICY "ven_scope_all" ON ventas FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- gastos
CREATE POLICY "gas_scope_all" ON gastos FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- remitos
CREATE POLICY "rem_scope_all" ON remitos FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- saldos_caja
CREATE POLICY "sc_scope_all" ON saldos_caja FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- caja_efectivo
CREATE POLICY "ce_scope_all" ON caja_efectivo FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- mp_movimientos
CREATE POLICY "mpm_scope_all" ON mp_movimientos FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- empleados
CREATE POLICY "emp_scope_all" ON empleados FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- empleado_archivos: scope vía empleados
CREATE POLICY "ea_scope_all" ON empleado_archivos FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM empleados e WHERE e.id = empleado_archivos.empleado_id
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM empleados e WHERE e.id = empleado_archivos.empleado_id
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))));

-- rrhh_empleados
CREATE POLICY "rrhh_emp_scope_all" ON rrhh_empleados FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- rrhh_novedades: scope vía rrhh_empleados
CREATE POLICY "rrhh_nov_scope_all" ON rrhh_novedades FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id = rrhh_novedades.empleado_id
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id = rrhh_novedades.empleado_id
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))));

-- rrhh_liquidaciones: scope vía rrhh_novedades → rrhh_empleados
CREATE POLICY "rrhh_liq_scope_all" ON rrhh_liquidaciones FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM rrhh_novedades n JOIN rrhh_empleados e ON e.id = n.empleado_id
    WHERE n.id = rrhh_liquidaciones.novedad_id
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rrhh_novedades n JOIN rrhh_empleados e ON e.id = n.empleado_id
    WHERE n.id = rrhh_liquidaciones.novedad_id
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))
  ));

-- rrhh_valores_doble: tabla de configuración global (valor del plus por feriado, etc).
CREATE POLICY "rrhh_vd_read" ON rrhh_valores_doble FOR SELECT TO authenticated USING (true);
CREATE POLICY "rrhh_vd_admin_write" ON rrhh_valores_doble FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

-- rrhh_historial_sueldos / rrhh_documentos / rrhh_pagos_especiales: scope vía empleado.
-- NOTA: empleado_id puede ser TEXT o UUID según migración, se asume que matchea con rrhh_empleados.id.
CREATE POLICY "rrhh_hs_scope_all" ON rrhh_historial_sueldos FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_historial_sueldos.empleado_id::text
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_historial_sueldos.empleado_id::text
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))));

CREATE POLICY "rrhh_doc_scope_all" ON rrhh_documentos FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_documentos.empleado_id::text
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_documentos.empleado_id::text
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))));

CREATE POLICY "rrhh_pe_scope_all" ON rrhh_pagos_especiales FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_pagos_especiales.empleado_id::text
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_pagos_especiales.empleado_id::text
    AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))));

-- Master data global: lectura autenticada, escritura admin.
CREATE POLICY "prov_read" ON proveedores FOR SELECT TO authenticated USING (true);
CREATE POLICY "prov_admin_write" ON proveedores FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

CREATE POLICY "ins_read" ON insumos FOR SELECT TO authenticated USING (true);
CREATE POLICY "ins_admin_write" ON insumos FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

CREATE POLICY "rec_read" ON recetas FOR SELECT TO authenticated USING (true);
CREATE POLICY "rec_admin_write" ON recetas FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

CREATE POLICY "ri_read" ON receta_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "ri_admin_write" ON receta_items FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

CREATE POLICY "cc_read" ON config_categorias FOR SELECT TO authenticated USING (true);
CREATE POLICY "cc_admin_write" ON config_categorias FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

-- mp_credenciales: SÓLO admin (contiene tokens MP).
CREATE POLICY "mpc_admin_all" ON mp_credenciales FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());

-- Tablas condicionales (pueden no existir): auditoria, mp_liquidaciones, blindaje_*.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='auditoria') THEN
    EXECUTE 'CREATE POLICY "aud_admin_read" ON auditoria FOR SELECT TO authenticated USING (auth_es_dueno_o_admin())';
    EXECUTE 'CREATE POLICY "aud_write" ON auditoria FOR INSERT TO authenticated WITH CHECK (true)';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='mp_liquidaciones') THEN
    EXECUTE 'CREATE POLICY "mpl_scope_all" ON mp_liquidaciones FOR ALL TO authenticated
      USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_tipos_documento') THEN
    EXECUTE 'CREATE POLICY "btd_read" ON blindaje_tipos_documento FOR SELECT TO authenticated USING (true)';
    EXECUTE 'CREATE POLICY "btd_admin_write" ON blindaje_tipos_documento FOR ALL TO authenticated
      USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin())';
  END IF;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_documentos') THEN
    EXECUTE 'CREATE POLICY "bd_scope_all" ON blindaje_documentos FOR ALL TO authenticated
      USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))';
  END IF;
END $$;
