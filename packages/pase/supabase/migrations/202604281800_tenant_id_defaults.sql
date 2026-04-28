-- ═══════════════════════════════════════════════════════════════════════════
-- HOTFIX: defaults de tenant_id en las 35 tablas (+ tenant_admins +
-- empleado_archivos legacy = 37 tablas).
--
-- Problema: tras la migración multi-tenant (etapa 2 NOT NULL + etapa 3b
-- DROP de policies viejas), CUALQUIER INSERT del frontend que no pase
-- tenant_id explícito falla con:
--    "new row violates row-level security policy for table X"
-- (la columna queda en NULL → la policy WITH CHECK con
--  `tenant_id = auth_tenant_id()` evalúa a NULL/FALSE → bloquea).
--
-- Bugs reportados in-the-wild: usuario_locales, usuario_permisos,
-- facturas, factura_items, ventas, gastos, movimientos, etc — todos
-- los call-sites (28 INSERTs distintos en src/) no pasan tenant_id.
--
-- Fix sistémico (Opción C): default de columna a auth_tenant_id().
--   - Para callers dueno/admin/encargado/cajero/etc: auth_tenant_id()
--     resuelve a su tenant → el INSERT entra correctamente sin que el
--     frontend tenga que pasarlo.
--   - Para superadmin: auth_tenant_id() = NULL → el INSERT falla con
--     NOT NULL constraint, esperado (UI de superadmin tiene que pasar
--     tenant_id explícito al INSERTar — caso ya resuelto en
--     OnboardingTenant.tsx, no es regresión).
--   - Para service_role (cron, endpoints API): auth.uid() = NULL →
--     auth_tenant_id() = NULL → INSERT falla a menos que pase tenant_id.
--     Los endpoints actuales (mp-sync, backup-tenants) ya pasan tenant_id
--     explícito, no son afectados.
--
-- NO toca RLS ni constraints. Solo SET DEFAULT. Operación metadata
-- (instantánea, sin lock pesado de tabla).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tablas que existen siempre post-etapa 2 + 3b (31) ─────────────────

ALTER TABLE usuarios               ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE locales                ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE usuario_locales        ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE usuario_permisos       ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE tenant_admins          ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE proveedores            ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE insumos                ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE recetas                ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE receta_items           ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE config_categorias      ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_valores_doble     ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE medios_cobro           ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE ventas                 ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE gastos                 ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE gastos_plantillas      ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE facturas               ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE factura_items          ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE movimientos            ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE remitos                ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE saldos_caja            ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE caja_efectivo          ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE mp_credenciales        ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE mp_movimientos         ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_empleados         ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_novedades         ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_liquidaciones     ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_documentos        ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_historial_sueldos ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE rrhh_pagos_especiales  ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE blindaje_documentos    ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();
ALTER TABLE auditoria              ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id();

-- ─── 2. Tablas condicionales (existencia variable según historia DB) ──────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='blindaje_tipos_documento') THEN
    EXECUTE 'ALTER TABLE blindaje_tipos_documento ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='factura_items_stock') THEN
    EXECUTE 'ALTER TABLE factura_items_stock ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='remito_items') THEN
    EXECUTE 'ALTER TABLE remito_items ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='mp_liquidaciones') THEN
    EXECUTE 'ALTER TABLE mp_liquidaciones ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='rrhh_adelantos') THEN
    EXECUTE 'ALTER TABLE rrhh_adelantos ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='empleado_archivos') THEN
    EXECUTE 'ALTER TABLE empleado_archivos ALTER COLUMN tenant_id SET DEFAULT auth_tenant_id()';
  END IF;
END $$;

-- ─── 3. Validación interna (no crítica) ───────────────────────────────────
-- Verifica que el default quedó aplicado en las 31 tablas obligatorias.
-- Si el script de aplicación hace COMMIT/ROLLBACK basado en el resultado,
-- este RAISE EXCEPTION lo detecta y aborta.

DO $$
DECLARE
  v_faltantes text[] := ARRAY[]::text[];
  v_tabla text;
  v_tablas_obligatorias text[] := ARRAY[
    'usuarios','locales','usuario_locales','usuario_permisos','tenant_admins',
    'proveedores','insumos','recetas','receta_items','config_categorias',
    'rrhh_valores_doble','medios_cobro','ventas','gastos','gastos_plantillas',
    'facturas','factura_items','movimientos','remitos','saldos_caja',
    'caja_efectivo','mp_credenciales','mp_movimientos','rrhh_empleados',
    'rrhh_novedades','rrhh_liquidaciones','rrhh_documentos','rrhh_historial_sueldos',
    'rrhh_pagos_especiales','blindaje_documentos','auditoria'
  ];
  v_default text;
BEGIN
  FOREACH v_tabla IN ARRAY v_tablas_obligatorias LOOP
    SELECT pg_get_expr(adbin, adrelid) INTO v_default
      FROM pg_attrdef
      JOIN pg_attribute ON adrelid = attrelid AND adnum = attnum
     WHERE attrelid = ('public.'||v_tabla)::regclass
       AND attname = 'tenant_id';
    IF v_default IS NULL OR v_default NOT LIKE '%auth_tenant_id%' THEN
      v_faltantes := array_append(v_faltantes, v_tabla);
    END IF;
  END LOOP;

  IF array_length(v_faltantes, 1) > 0 THEN
    RAISE EXCEPTION 'DEFAULT_NO_APLICADO: tablas sin auth_tenant_id() default: %',
      array_to_string(v_faltantes, ', ');
  END IF;
  RAISE NOTICE 'OK: defaults de tenant_id aplicados en 31 tablas obligatorias';
END $$;
