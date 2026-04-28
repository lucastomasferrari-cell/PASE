-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — ETAPA 3b: DROP de policies viejas (sin _mt).
--
-- LA SENSIBLE. Después de 24h+ de etapa 3a (dual policies _mt + viejas
-- coexistiendo via PERMISSIVE OR), las _mt están validadas en producción
-- por uso real. Esta migration:
--
-- 1. Detecta una tabla no inventariada en el design original
--    (gastos_plantillas) y le agrega tenant_id + policy _mt antes del
--    DROP de la vieja, para que no quede sin RLS funcional.
-- 2. DROP las 55 policies viejas (lista exacta abajo).
-- 3. Resultado final: cada tabla tiene solo policies _mt como single
--    source of truth de RLS multi-tenant.
--
-- Tests automáticos (rls_isolation.cjs) deben pasar 100% después de
-- esta migration. Validación incluida en el script de aplicación.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. gastos_plantillas: tabla no inventariada (post-design-doc) ─────────
-- Agregar tenant_id NOT NULL + policy _mt + DROP la vieja.

ALTER TABLE gastos_plantillas ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

-- Backfill desde locales.tenant_id si tiene local_id, sino Neko.
UPDATE gastos_plantillas gp SET tenant_id = l.tenant_id FROM locales l WHERE l.id = gp.local_id AND gp.tenant_id IS NULL;
UPDATE gastos_plantillas SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE gastos_plantillas ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gastos_plantillas_tenant ON gastos_plantillas(tenant_id);

-- Policy _mt similar a gastos.
CREATE POLICY "gastos_plantillas_mt" ON gastos_plantillas FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
  ))
  WITH CHECK (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
  ));

-- ─── 2. DROP de las 55 policies viejas ─────────────────────────────────────

-- Patrón A — scope_all
DROP POLICY IF EXISTS "mov_scope_all" ON movimientos;
DROP POLICY IF EXISTS "fac_scope_all" ON facturas;
DROP POLICY IF EXISTS "ven_scope_all" ON ventas;
DROP POLICY IF EXISTS "gas_scope_all" ON gastos;
DROP POLICY IF EXISTS "rem_scope_all" ON remitos;
DROP POLICY IF EXISTS "sc_scope_all" ON saldos_caja;
DROP POLICY IF EXISTS "ce_scope_all" ON caja_efectivo;
DROP POLICY IF EXISTS "mpm_scope_all" ON mp_movimientos;
DROP POLICY IF EXISTS "rrhh_emp_scope_all" ON rrhh_empleados;
DROP POLICY IF EXISTS "bd_scope_all" ON blindaje_documentos;
DROP POLICY IF EXISTS "mpl_scope_all" ON mp_liquidaciones;
DROP POLICY IF EXISTS "gp_scope_all" ON gastos_plantillas;

-- Patrón B — child scope_all
DROP POLICY IF EXISTS "fi_scope_all" ON factura_items;
DROP POLICY IF EXISTS "fis_scope_all" ON factura_items_stock;
DROP POLICY IF EXISTS "rmi_scope_all" ON remito_items;
DROP POLICY IF EXISTS "rrhh_nov_scope_all" ON rrhh_novedades;
DROP POLICY IF EXISTS "rrhh_liq_scope_all" ON rrhh_liquidaciones;
DROP POLICY IF EXISTS "rrhh_doc_scope_all" ON rrhh_documentos;
DROP POLICY IF EXISTS "rrhh_hs_scope_all" ON rrhh_historial_sueldos;
DROP POLICY IF EXISTS "rrhh_pe_scope_all" ON rrhh_pagos_especiales;
DROP POLICY IF EXISTS "rrhh_ad_scope_all" ON rrhh_adelantos;
DROP POLICY IF EXISTS "ea_scope_all" ON empleado_archivos;

-- Patrón C — read/write con permisos
DROP POLICY IF EXISTS "prov_read" ON proveedores;
DROP POLICY IF EXISTS "prov_write" ON proveedores;
DROP POLICY IF EXISTS "ins_read" ON insumos;
DROP POLICY IF EXISTS "ins_write" ON insumos;
DROP POLICY IF EXISTS "rec_read" ON recetas;
DROP POLICY IF EXISTS "rec_write" ON recetas;
DROP POLICY IF EXISTS "ri_read" ON receta_items;
DROP POLICY IF EXISTS "ri_write" ON receta_items;
DROP POLICY IF EXISTS "cc_read" ON config_categorias;
DROP POLICY IF EXISTS "cc_write" ON config_categorias;
DROP POLICY IF EXISTS "rrhh_vd_read" ON rrhh_valores_doble;
DROP POLICY IF EXISTS "rrhh_vd_write" ON rrhh_valores_doble;
DROP POLICY IF EXISTS "btd_read" ON blindaje_tipos_documento;
DROP POLICY IF EXISTS "btd_admin_write" ON blindaje_tipos_documento;
DROP POLICY IF EXISTS "mc_select" ON medios_cobro;
DROP POLICY IF EXISTS "mc_write" ON medios_cobro;

-- Especiales — usuarios y dependencias
DROP POLICY IF EXISTS "usuarios_select" ON usuarios;
DROP POLICY IF EXISTS "usuarios_self_update" ON usuarios;
DROP POLICY IF EXISTS "usuarios_admin_insert" ON usuarios;
DROP POLICY IF EXISTS "usuarios_admin_update" ON usuarios;
DROP POLICY IF EXISTS "usuarios_admin_delete" ON usuarios;
DROP POLICY IF EXISTS "usuarios_select_perm" ON usuarios;
DROP POLICY IF EXISTS "up_select" ON usuario_permisos;
DROP POLICY IF EXISTS "up_admin_write" ON usuario_permisos;
DROP POLICY IF EXISTS "up_select_perm" ON usuario_permisos;
DROP POLICY IF EXISTS "ul_select" ON usuario_locales;
DROP POLICY IF EXISTS "ul_admin_write" ON usuario_locales;
DROP POLICY IF EXISTS "ul_select_perm" ON usuario_locales;

-- locales / mp_credenciales / auditoria
DROP POLICY IF EXISTS "locales_read" ON locales;
DROP POLICY IF EXISTS "locales_admin_write" ON locales;
DROP POLICY IF EXISTS "mpc_admin_all" ON mp_credenciales;
DROP POLICY IF EXISTS "aud_admin_read" ON auditoria;
DROP POLICY IF EXISTS "aud_write" ON auditoria;

-- ─── 3. usuarios necesita una nueva policy de self-update ────────────────
-- La policy usuarios_mt_admin_write solo permite admin/superadmin update.
-- usuarios_self_update vieja permitía a CUALQUIER usuario actualizar su propia
-- fila (uso: cambiar password_temporal, actualizar nombre, etc). Recreamos
-- esa policy bajo el patrón _mt — sigue siendo permissive para self.

CREATE POLICY "usuarios_mt_self_update" ON usuarios FOR UPDATE TO authenticated
  USING (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid());
