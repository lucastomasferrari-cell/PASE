-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — ETAPA 2: Schema propagation de tenant_id.
--
-- Agrega columna tenant_id NOT NULL a las 35 tablas restantes y backfillea
-- todas las filas existentes al tenant Neko. NO toca RLS — el sistema sigue
-- funcionando idéntico tras esta migración (las queries del frontend no
-- usan tenant_id todavía).
--
-- Orden topológico:
--   B1: locales (raíz)
--   B2: 12 tablas con local_id NOT NULL → backfill desde locales
--   B3: medios_cobro (local_id nullable, mix de globales y por local)
--   B4: 6 tablas catálogo (sin local_id) → backfill directo a Neko
--   B5: usuario_locales, usuario_permisos → backfill desde usuarios
--   B6: 12 tablas hijas → backfill desde parent
--   B7: auditoria → backfill directo a Neko
--
-- Total: 1 + 12 + 1 + 6 + 2 + 12 + 1 = 35.
-- ═══════════════════════════════════════════════════════════════════════════

-- Captura el UUID de Neko en una variable plpgsql que se usa abajo.
-- (No se puede usar variables a nivel SQL plano sin DO $$, así que se inlines
--  con SELECT id FROM tenants WHERE slug='neko' donde haga falta.)

-- ─── B1: locales (raíz) ────────────────────────────────────────────────────

ALTER TABLE locales ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE locales SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE locales ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_locales_tenant ON locales(tenant_id);

-- ─── B2: 12 tablas raíz con local_id NOT NULL ──────────────────────────────
-- Todas backfillean tenant_id desde locales vía la FK local_id.

-- ventas
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE ventas v SET tenant_id = l.tenant_id FROM locales l WHERE l.id = v.local_id AND v.tenant_id IS NULL;
ALTER TABLE ventas ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ventas_tenant ON ventas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ventas_tenant_local ON ventas(tenant_id, local_id);

-- gastos
ALTER TABLE gastos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE gastos g SET tenant_id = l.tenant_id FROM locales l WHERE l.id = g.local_id AND g.tenant_id IS NULL;
-- gastos.local_id puede ser nullable (gastos globales del dueño). Para esos,
-- backfill directo a Neko (toda la data legacy es de Lucas).
UPDATE gastos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE gastos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gastos_tenant ON gastos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gastos_tenant_local ON gastos(tenant_id, local_id);

-- facturas
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE facturas f SET tenant_id = l.tenant_id FROM locales l WHERE l.id = f.local_id AND f.tenant_id IS NULL;
ALTER TABLE facturas ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facturas_tenant ON facturas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_facturas_tenant_local ON facturas(tenant_id, local_id);

-- movimientos
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE movimientos m SET tenant_id = l.tenant_id FROM locales l WHERE l.id = m.local_id AND m.tenant_id IS NULL;
-- movimientos.local_id puede ser nullable para movs legacy. Backfill a Neko.
UPDATE movimientos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE movimientos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movimientos_tenant ON movimientos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_tenant_local ON movimientos(tenant_id, local_id);

-- remitos
ALTER TABLE remitos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE remitos r SET tenant_id = l.tenant_id FROM locales l WHERE l.id = r.local_id AND r.tenant_id IS NULL;
ALTER TABLE remitos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_remitos_tenant ON remitos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_remitos_tenant_local ON remitos(tenant_id, local_id);

-- saldos_caja
ALTER TABLE saldos_caja ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE saldos_caja s SET tenant_id = l.tenant_id FROM locales l WHERE l.id = s.local_id AND s.tenant_id IS NULL;
-- Si hay saldos legacy con local_id NULL → Neko.
UPDATE saldos_caja SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE saldos_caja ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saldos_caja_tenant ON saldos_caja(tenant_id);

-- caja_efectivo
ALTER TABLE caja_efectivo ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE caja_efectivo c SET tenant_id = l.tenant_id FROM locales l WHERE l.id = c.local_id AND c.tenant_id IS NULL;
ALTER TABLE caja_efectivo ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_caja_efectivo_tenant ON caja_efectivo(tenant_id);

-- mp_credenciales
ALTER TABLE mp_credenciales ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE mp_credenciales c SET tenant_id = l.tenant_id FROM locales l WHERE l.id = c.local_id AND c.tenant_id IS NULL;
ALTER TABLE mp_credenciales ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mp_credenciales_tenant ON mp_credenciales(tenant_id);

-- mp_movimientos
ALTER TABLE mp_movimientos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE mp_movimientos m SET tenant_id = l.tenant_id FROM locales l WHERE l.id = m.local_id AND m.tenant_id IS NULL;
ALTER TABLE mp_movimientos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mp_movimientos_tenant ON mp_movimientos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mp_movimientos_tenant_local ON mp_movimientos(tenant_id, local_id);

-- rrhh_empleados
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_empleados e SET tenant_id = l.tenant_id FROM locales l WHERE l.id = e.local_id AND e.tenant_id IS NULL;
ALTER TABLE rrhh_empleados ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_empleados_tenant ON rrhh_empleados(tenant_id);

-- empleados (legacy deprecada — la tabla puede no existir si ya fue dropeada).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='empleados') THEN
    EXECUTE 'ALTER TABLE empleados ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE empleados e SET tenant_id = l.tenant_id FROM locales l WHERE l.id = e.local_id AND e.tenant_id IS NULL';
    EXECUTE 'UPDATE empleados SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE empleados ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_empleados_tenant ON empleados(tenant_id)';
  END IF;
END $$;

-- blindaje_documentos
ALTER TABLE blindaje_documentos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE blindaje_documentos b SET tenant_id = l.tenant_id FROM locales l WHERE l.id = b.local_id AND b.tenant_id IS NULL;
-- Defensive: si hay docs sin local_id → Neko.
UPDATE blindaje_documentos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE blindaje_documentos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blindaje_documentos_tenant ON blindaje_documentos(tenant_id);

-- ─── B3: medios_cobro (local_id NULLABLE) ──────────────────────────────────
-- Los medios con local_id NOT NULL → backfill desde locales.
-- Los medios globales (local_id NULL) → backfill directo a Neko.

ALTER TABLE medios_cobro ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE medios_cobro mc SET tenant_id = l.tenant_id FROM locales l WHERE l.id = mc.local_id AND mc.tenant_id IS NULL;
UPDATE medios_cobro SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE medios_cobro ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_medios_cobro_tenant ON medios_cobro(tenant_id);

-- ─── B4: 6 tablas catálogo (sin local_id, hoy globales) ────────────────────
-- Backfill directo a Neko (toda la data legacy es de Lucas).

-- proveedores
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE proveedores SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE proveedores ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proveedores_tenant ON proveedores(tenant_id);

-- insumos
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE insumos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE insumos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insumos_tenant ON insumos(tenant_id);

-- recetas
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE recetas SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE recetas ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recetas_tenant ON recetas(tenant_id);

-- config_categorias
ALTER TABLE config_categorias ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE config_categorias SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE config_categorias ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_config_categorias_tenant ON config_categorias(tenant_id);

-- rrhh_valores_doble
ALTER TABLE rrhh_valores_doble ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_valores_doble SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE rrhh_valores_doble ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_valores_doble_tenant ON rrhh_valores_doble(tenant_id);

-- blindaje_tipos_documento (existencia condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_tipos_documento') THEN
    EXECUTE 'ALTER TABLE blindaje_tipos_documento ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE blindaje_tipos_documento SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE blindaje_tipos_documento ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_blindaje_tipos_documento_tenant ON blindaje_tipos_documento(tenant_id)';
  END IF;
END $$;

-- ─── B5: usuario_locales, usuario_permisos ─────────────────────────────────
-- Backfill desde usuarios.tenant_id. Como el superadmin tiene tenant_id NULL,
-- las filas en estas tablas correspondientes al superadmin (si existen)
-- quedarían sin tenant. Backfill a Neko en ese caso (defensive — pero el
-- superadmin no debería tener filas en estas tablas porque ve todo).

-- usuario_locales
ALTER TABLE usuario_locales ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE usuario_locales ul SET tenant_id = u.tenant_id FROM usuarios u WHERE u.id = ul.usuario_id AND ul.tenant_id IS NULL;
-- Defensive: filas con usuario superadmin (tenant_id NULL en usuarios) → Neko.
UPDATE usuario_locales SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE usuario_locales ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuario_locales_tenant ON usuario_locales(tenant_id);

-- usuario_permisos
ALTER TABLE usuario_permisos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE usuario_permisos up SET tenant_id = u.tenant_id FROM usuarios u WHERE u.id = up.usuario_id AND up.tenant_id IS NULL;
UPDATE usuario_permisos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE usuario_permisos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuario_permisos_tenant ON usuario_permisos(tenant_id);

-- ─── B6: 12 tablas hijas (heredan via parent.id) ───────────────────────────

-- factura_items: parent facturas
ALTER TABLE factura_items ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE factura_items fi SET tenant_id = f.tenant_id FROM facturas f WHERE f.id = fi.factura_id AND fi.tenant_id IS NULL;
UPDATE factura_items SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE factura_items ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_factura_items_tenant ON factura_items(tenant_id);

-- factura_items_stock (existencia condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='factura_items_stock') THEN
    EXECUTE 'ALTER TABLE factura_items_stock ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE factura_items_stock fi SET tenant_id = f.tenant_id FROM facturas f WHERE f.id = fi.factura_id AND fi.tenant_id IS NULL';
    EXECUTE 'UPDATE factura_items_stock SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE factura_items_stock ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_factura_items_stock_tenant ON factura_items_stock(tenant_id)';
  END IF;
END $$;

-- receta_items: parent recetas
ALTER TABLE receta_items ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE receta_items ri SET tenant_id = r.tenant_id FROM recetas r WHERE r.id = ri.receta_id AND ri.tenant_id IS NULL;
UPDATE receta_items SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE receta_items ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receta_items_tenant ON receta_items(tenant_id);

-- remito_items (existencia condicional)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='remito_items') THEN
    EXECUTE 'ALTER TABLE remito_items ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE remito_items ri SET tenant_id = r.tenant_id FROM remitos r WHERE r.id = ri.remito_id AND ri.tenant_id IS NULL';
    EXECUTE 'UPDATE remito_items SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE remito_items ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_remito_items_tenant ON remito_items(tenant_id)';
  END IF;
END $$;

-- mp_liquidaciones (existencia condicional, parent mp_credenciales)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='mp_liquidaciones') THEN
    EXECUTE 'ALTER TABLE mp_liquidaciones ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE mp_liquidaciones ml SET tenant_id = c.tenant_id FROM mp_credenciales c WHERE c.id = ml.credencial_id AND ml.tenant_id IS NULL';
    EXECUTE 'UPDATE mp_liquidaciones SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE mp_liquidaciones ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_mp_liquidaciones_tenant ON mp_liquidaciones(tenant_id)';
  END IF;
END $$;

-- rrhh_novedades: parent rrhh_empleados
ALTER TABLE rrhh_novedades ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_novedades n SET tenant_id = e.tenant_id FROM rrhh_empleados e WHERE e.id = n.empleado_id AND n.tenant_id IS NULL;
UPDATE rrhh_novedades SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE rrhh_novedades ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_novedades_tenant ON rrhh_novedades(tenant_id);

-- rrhh_liquidaciones: parent rrhh_novedades
ALTER TABLE rrhh_liquidaciones ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_liquidaciones l SET tenant_id = n.tenant_id FROM rrhh_novedades n WHERE n.id = l.novedad_id AND l.tenant_id IS NULL;
UPDATE rrhh_liquidaciones SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE rrhh_liquidaciones ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_liquidaciones_tenant ON rrhh_liquidaciones(tenant_id);

-- rrhh_documentos: parent rrhh_empleados
ALTER TABLE rrhh_documentos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_documentos d SET tenant_id = e.tenant_id FROM rrhh_empleados e WHERE e.id::text = d.empleado_id::text AND d.tenant_id IS NULL;
UPDATE rrhh_documentos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE rrhh_documentos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_documentos_tenant ON rrhh_documentos(tenant_id);

-- rrhh_historial_sueldos: parent rrhh_empleados
ALTER TABLE rrhh_historial_sueldos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_historial_sueldos h SET tenant_id = e.tenant_id FROM rrhh_empleados e WHERE e.id::text = h.empleado_id::text AND h.tenant_id IS NULL;
UPDATE rrhh_historial_sueldos SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE rrhh_historial_sueldos ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_historial_sueldos_tenant ON rrhh_historial_sueldos(tenant_id);

-- rrhh_pagos_especiales: parent rrhh_empleados
ALTER TABLE rrhh_pagos_especiales ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
UPDATE rrhh_pagos_especiales p SET tenant_id = e.tenant_id FROM rrhh_empleados e WHERE e.id::text = p.empleado_id::text AND p.tenant_id IS NULL;
UPDATE rrhh_pagos_especiales SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;
ALTER TABLE rrhh_pagos_especiales ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rrhh_pagos_especiales_tenant ON rrhh_pagos_especiales(tenant_id);

-- rrhh_adelantos (existencia condicional, parent rrhh_empleados)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='rrhh_adelantos') THEN
    EXECUTE 'ALTER TABLE rrhh_adelantos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE rrhh_adelantos a SET tenant_id = e.tenant_id FROM rrhh_empleados e WHERE e.id::text = a.empleado_id::text AND a.tenant_id IS NULL';
    EXECUTE 'UPDATE rrhh_adelantos SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE rrhh_adelantos ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_rrhh_adelantos_tenant ON rrhh_adelantos(tenant_id)';
  END IF;
END $$;

-- empleado_archivos: parent empleados (legacy). La tabla empleados ya
-- fue dropeada en una migración previa (deprecación 26-04). Como
-- empleado_archivos tiene 0 rows según diag (huérfana), backfill directo
-- a Neko sin necesidad de referenciar empleados (que no existe).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='empleado_archivos') THEN
    EXECUTE 'ALTER TABLE empleado_archivos ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id)';
    EXECUTE 'UPDATE empleado_archivos SET tenant_id = (SELECT id FROM tenants WHERE slug=''neko'') WHERE tenant_id IS NULL';
    EXECUTE 'ALTER TABLE empleado_archivos ALTER COLUMN tenant_id SET NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_empleado_archivos_tenant ON empleado_archivos(tenant_id)';
  END IF;
END $$;

-- ─── B7: auditoria ─────────────────────────────────────────────────────────
-- Backfill directo a Neko (toda la audit pre-migración es de Lucas).
--
-- La tabla auditoria tiene triggers BEFORE UPDATE/DELETE (append-only por
-- diseño, ver 202604261304_auditoria_append_only.sql) que bloquean
-- cualquier UPDATE incluso con service_role. Para el backfill necesitamos
-- desactivar esos triggers temporalmente DENTRO de la misma transacción
-- (si la TX falla, los DISABLE TRIGGER también se rollbackean por la
-- semántica transaccional de DDL en Postgres).

ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

UPDATE auditoria SET tenant_id = (SELECT id FROM tenants WHERE slug='neko') WHERE tenant_id IS NULL;

ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;

ALTER TABLE auditoria ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auditoria_tenant ON auditoria(tenant_id);
