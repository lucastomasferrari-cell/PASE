-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — ETAPA 3a: RLS rewrite con dual policies (etapa defensiva).
--
-- Estrategia: AGREGAR las policies nuevas con dual filter
-- (tenant_id + lógica vieja + bypass superadmin) sin tocar las viejas.
-- Postgres aplica OR entre policies PERMISSIVE del mismo (tabla, comando, rol),
-- así que un usuario pasa si CUALQUIERA lo deja pasar. Como las viejas siguen
-- funcionando idénticamente, nadie queda bloqueado.
--
-- Las policies nuevas tienen sufijo "_mt" para coexistir con las "_scope_all"
-- y similares originales.
--
-- Etapa 3b (separada, futura, después de 24h sin issues): DROP de las viejas.
--
-- Esta migration:
--   1. Modifica auth_locales_visibles() a su forma definitive multi-tenant.
--      auth_es_dueno_o_admin() ya fue extendida en el hotfix 202604281202
--      para incluir 'superadmin'.
--   2. Crea policies _mt en TODAS las tablas con tenant_id + RLS habilitada.
--   3. Crea policies en tenants y tenant_admins por primera vez.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. auth_locales_visibles() — versión multi-tenant ─────────────────────
-- Diferencia con la versión actual:
--   - superadmin → NULL (sentinel "ve todos") explícito al inicio.
--   - dueño/admin → todos los locales DE SU tenant (filtra locales por
--     tenant_id, en lugar de retornar NULL incondicional).
--   - encargado → sus locales en usuario_locales (sin cambio).
--
-- Esto es importante para multi-tenant: el dueño A NO debe ver locales del
-- tenant B aunque ambos sean dueños. La nueva lógica usa locales.tenant_id
-- (que existe desde Etapa 2) para filtrar.

CREATE OR REPLACE FUNCTION auth_locales_visibles()
RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth_es_superadmin() THEN NULL::integer[]
    WHEN auth_es_dueno_o_admin() THEN
      COALESCE(
        (SELECT array_agg(l.id) FROM locales l WHERE l.tenant_id = auth_tenant_id()),
        ARRAY[]::integer[]
      )
    ELSE COALESCE(
      (SELECT array_agg(ul.local_id) FROM usuario_locales ul
        WHERE ul.usuario_id = auth_usuario_id()),
      ARRAY[]::integer[]
    )
  END;
$$;

-- ─── 2. Policies _mt para tablas raíz con local_id (Patrón A) ─────────────

-- movimientos
CREATE POLICY "movimientos_mt" ON movimientos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- facturas
CREATE POLICY "facturas_mt" ON facturas FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- ventas
CREATE POLICY "ventas_mt" ON ventas FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- gastos
CREATE POLICY "gastos_mt" ON gastos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
  ));

-- remitos
CREATE POLICY "remitos_mt" ON remitos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- saldos_caja
CREATE POLICY "saldos_caja_mt" ON saldos_caja FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- caja_efectivo
CREATE POLICY "caja_efectivo_mt" ON caja_efectivo FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- mp_movimientos
CREATE POLICY "mp_movimientos_mt" ON mp_movimientos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- rrhh_empleados
CREATE POLICY "rrhh_empleados_mt" ON rrhh_empleados FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  ));

-- blindaje_documentos
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_documentos') THEN
    EXECUTE 'CREATE POLICY "blindaje_documentos_mt" ON blindaje_documentos FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      ))
      WITH CHECK (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
      ))';
  END IF;
END $$;

-- medios_cobro: caso especial (local_id NULLABLE = medio global del tenant).
-- Un usuario del tenant ve TODOS los medios de su tenant (globales + de sus locales).
CREATE POLICY "medios_cobro_mt" ON medios_cobro FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())
    )
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')
  ));

-- ─── 3. Policies _mt para tablas hijas (Patrón B) ─────────────────────────
-- Filtro tenant_id directo + filtro vía parent.

-- factura_items
CREATE POLICY "factura_items_mt" ON factura_items FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM facturas f WHERE f.id = factura_items.factura_id
      AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles())))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM facturas f WHERE f.id = factura_items.factura_id
      AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles())))
  ));

-- factura_items_stock (condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='factura_items_stock') THEN
    EXECUTE 'CREATE POLICY "factura_items_stock_mt" ON factura_items_stock FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM facturas f WHERE f.id = factura_items_stock.factura_id
          AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles())))
      ))
      WITH CHECK (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM facturas f WHERE f.id = factura_items_stock.factura_id
          AND (auth_es_dueno_o_admin() OR f.local_id = ANY(auth_locales_visibles())))
      ))';
  END IF;
END $$;

-- remito_items (condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='remito_items') THEN
    EXECUTE 'CREATE POLICY "remito_items_mt" ON remito_items FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM remitos r WHERE r.id = remito_items.remito_id
          AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles())))
      ))
      WITH CHECK (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM remitos r WHERE r.id = remito_items.remito_id
          AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles())))
      ))';
  END IF;
END $$;

-- rrhh_novedades
CREATE POLICY "rrhh_novedades_mt" ON rrhh_novedades FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id = rrhh_novedades.empleado_id
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id = rrhh_novedades.empleado_id
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ));

-- rrhh_liquidaciones
CREATE POLICY "rrhh_liquidaciones_mt" ON rrhh_liquidaciones FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (
      SELECT 1 FROM rrhh_novedades n JOIN rrhh_empleados e ON e.id = n.empleado_id
      WHERE n.id = rrhh_liquidaciones.novedad_id
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))
    )
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (
      SELECT 1 FROM rrhh_novedades n JOIN rrhh_empleados e ON e.id = n.empleado_id
      WHERE n.id = rrhh_liquidaciones.novedad_id
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles()))
    )
  ));

-- rrhh_documentos
CREATE POLICY "rrhh_documentos_mt" ON rrhh_documentos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_documentos.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_documentos.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ));

-- rrhh_historial_sueldos
CREATE POLICY "rrhh_historial_sueldos_mt" ON rrhh_historial_sueldos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_historial_sueldos.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_historial_sueldos.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ));

-- rrhh_pagos_especiales
CREATE POLICY "rrhh_pagos_especiales_mt" ON rrhh_pagos_especiales FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_pagos_especiales.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_pagos_especiales.empleado_id::text
      AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
  ));

-- rrhh_adelantos (condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='rrhh_adelantos') THEN
    EXECUTE 'CREATE POLICY "rrhh_adelantos_mt" ON rrhh_adelantos FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_adelantos.empleado_id::text
          AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
      ))
      WITH CHECK (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM rrhh_empleados e WHERE e.id::text = rrhh_adelantos.empleado_id::text
          AND (auth_es_dueno_o_admin() OR e.local_id = ANY(auth_locales_visibles())))
      ))';
  END IF;
END $$;

-- empleado_archivos (condicional, parent empleados ya no existe).
-- Como empleado_archivos tiene 0 rows y el parent dropeado, simplificamos
-- la check: solo tenant filter.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='empleado_archivos') THEN
    EXECUTE 'CREATE POLICY "empleado_archivos_mt" ON empleado_archivos FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
      WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))';
  END IF;
END $$;

-- mp_liquidaciones (condicional, parent mp_credenciales)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='mp_liquidaciones') THEN
    EXECUTE 'CREATE POLICY "mp_liquidaciones_mt" ON mp_liquidaciones FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM mp_credenciales c WHERE c.id = mp_liquidaciones.credencial_id
          AND (auth_es_dueno_o_admin() OR c.local_id = ANY(auth_locales_visibles())))
      ))
      WITH CHECK (auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        EXISTS (SELECT 1 FROM mp_credenciales c WHERE c.id = mp_liquidaciones.credencial_id
          AND (auth_es_dueno_o_admin() OR c.local_id = ANY(auth_locales_visibles())))
      ))';
  END IF;
END $$;

-- ─── 4. Master con permiso granular (Patrón C) ────────────────────────────

-- proveedores
CREATE POLICY "proveedores_mt" ON proveedores FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('proveedores')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('proveedores')));

-- insumos
CREATE POLICY "insumos_mt" ON insumos FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('insumos')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('insumos')));

-- recetas
CREATE POLICY "recetas_mt" ON recetas FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('recetas')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('recetas')));

-- receta_items
CREATE POLICY "receta_items_mt" ON receta_items FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('recetas')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('recetas')));

-- config_categorias
CREATE POLICY "config_categorias_mt" ON config_categorias FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')));

-- rrhh_valores_doble
CREATE POLICY "rrhh_valores_doble_mt" ON rrhh_valores_doble FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('rrhh')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('rrhh')));

-- blindaje_tipos_documento (condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_tipos_documento') THEN
    EXECUTE 'CREATE POLICY "blindaje_tipos_documento_mt" ON blindaje_tipos_documento FOR ALL TO authenticated
      USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso(''blindaje'')))
      WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso(''blindaje'')))';
  END IF;
END $$;

-- ─── 5. Tablas especiales ─────────────────────────────────────────────────

-- locales: read para usuarios del tenant; write admin.
CREATE POLICY "locales_mt_read" ON locales FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());
CREATE POLICY "locales_mt_admin_write" ON locales FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

-- usuarios: superadmin ve todo; resto ve los del tenant + a sí mismo.
CREATE POLICY "usuarios_mt_select" ON usuarios FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR auth_id = auth.uid()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  );
CREATE POLICY "usuarios_mt_admin_write" ON usuarios FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

-- usuario_permisos
CREATE POLICY "usuario_permisos_mt" ON usuario_permisos FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR usuario_id = auth_usuario_id()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  )
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

-- usuario_locales
CREATE POLICY "usuario_locales_mt" ON usuario_locales FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR usuario_id = auth_usuario_id()
    OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_tiene_permiso('usuarios')))
  )
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

-- mp_credenciales
CREATE POLICY "mp_credenciales_mt" ON mp_credenciales FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));

-- auditoria
CREATE POLICY "auditoria_mt_read" ON auditoria FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));
CREATE POLICY "auditoria_mt_write" ON auditoria FOR INSERT TO authenticated
  WITH CHECK (auth_es_superadmin() OR tenant_id = auth_tenant_id());

-- ─── 6. tenants y tenant_admins (primera vez) ─────────────────────────────

-- tenants
CREATE POLICY "tenants_select" ON tenants FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR id = auth_tenant_id());
CREATE POLICY "tenants_admin_write" ON tenants FOR ALL TO authenticated
  USING (auth_es_superadmin())
  WITH CHECK (auth_es_superadmin());

-- tenant_admins
CREATE POLICY "tenant_admins_select" ON tenant_admins FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());
CREATE POLICY "tenant_admins_admin_write" ON tenant_admins FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()));
