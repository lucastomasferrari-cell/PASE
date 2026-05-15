-- ═══════════════════════════════════════════════════════════════════════════
-- F1.2b — Agregar 'clientes' a eliminar_tenant_completo + restore_tenant
-- ═══════════════════════════════════════════════════════════════════════════
-- Deuda corta documentada en F1.2 (202605151730_f1_2_clientes.sql).
-- Sin esto, el drop de un tenant falla con FK violation si tiene clientes
-- (clientes.tenant_id → tenants(id) sin ON DELETE CASCADE).
--
-- Esta migration reescribe ambas RPCs idénticas a la versión F1.1 pero con
-- 'clientes' agregado en el lugar topológico correcto:
--   - v_orden_delete: clientes va ANTES de usuarios (FK created_by/updated_by
--     → usuarios) y DESPUÉS de ventas_pos si estuviera (no está en el array).
--   - v_orden_insert: clientes va DESPUÉS de usuarios+locales y ANTES de
--     ventas (la FK ventas_pos.cliente_id queda enviable después).

CREATE OR REPLACE FUNCTION eliminar_tenant_completo(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_caller_tenant uuid;
  v_filas_borradas bigint := 0;
  v_rows int;
  v_table_name text;

  v_orden_delete text[] := ARRAY[
    'empleado_archivos',
    'movimientos',
    'rrhh_adelantos', 'rrhh_pagos_especiales', 'rrhh_historial_sueldos',
    'rrhh_documentos', 'rrhh_liquidaciones', 'rrhh_novedades',
    'remitos',
    'factura_items', 'facturas',
    'blindaje_documentos',
    'mp_liquidaciones', 'mp_movimientos',
    'caja_efectivo', 'saldos_caja',
    'gastos_plantillas', 'gastos', 'ventas',
    'rrhh_empleados', 'mp_credenciales',
    'receta_insumos', 'recetas', 'insumos',
    -- F1.2b: clientes va antes de usuarios (FK created_by → usuarios).
    'clientes',
    'medios_cobro', 'blindaje_tipos_documento', 'rrhh_valores_doble',
    'config_categorias', 'proveedores',
    'tenant_admins',
    'usuario_permisos', 'usuario_locales',
    'locales', 'usuarios'
  ];
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin puede ejecutar eliminar_tenant_completo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND: tenant % no existe', p_tenant_id;
  END IF;
  SELECT tenant_id INTO v_caller_tenant FROM usuarios WHERE auth_id = v_caller_uid;
  IF v_caller_tenant IS NOT NULL AND v_caller_tenant = p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_ES_DEL_CALLER: no podés borrar el tenant en el que estás autenticado';
  END IF;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;
  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;
  FOREACH v_table_name IN ARRAY v_orden_delete LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name) THEN
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name) USING p_tenant_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_filas_borradas := v_filas_borradas + v_rows;
    END IF;
  END LOOP;
  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;
  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'filas_borradas', v_filas_borradas,
    'eliminado_por_uid', v_caller_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION restore_tenant(
  p_tenant_id uuid,
  p_backup_path text,
  p_backup_json jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_backup_tenant_id uuid;
  v_backup_version int;
  v_filas_borradas bigint := 0;
  v_filas_restauradas bigint := 0;
  v_rows int;
  v_table_name text;
  v_seq text;

  v_orden_delete text[] := ARRAY[
    'empleado_archivos',
    'auditoria',
    'movimientos',
    'rrhh_adelantos', 'rrhh_pagos_especiales', 'rrhh_historial_sueldos',
    'rrhh_documentos', 'rrhh_liquidaciones', 'rrhh_novedades',
    'remitos',
    'factura_items', 'facturas',
    'blindaje_documentos',
    'mp_liquidaciones', 'mp_movimientos',
    'caja_efectivo', 'saldos_caja',
    'gastos_plantillas', 'gastos', 'ventas',
    'rrhh_empleados', 'mp_credenciales',
    'receta_insumos', 'recetas', 'insumos',
    -- F1.2b: clientes antes de usuarios.
    'clientes',
    'medios_cobro', 'blindaje_tipos_documento', 'rrhh_valores_doble',
    'config_categorias', 'proveedores',
    'tenant_admins',
    'usuario_permisos', 'usuario_locales',
    'locales', 'usuarios'
  ];

  v_orden_insert text[] := ARRAY[
    'usuarios', 'locales',
    'usuario_locales', 'usuario_permisos', 'tenant_admins',
    'proveedores', 'config_categorias',
    'rrhh_valores_doble', 'blindaje_tipos_documento', 'medios_cobro',
    -- F1.2b: clientes después de locales+usuarios (FK created_by/updated_by).
    'clientes',
    'insumos', 'recetas', 'receta_insumos',
    'mp_credenciales', 'rrhh_empleados',
    'ventas', 'gastos', 'gastos_plantillas',
    'saldos_caja', 'caja_efectivo',
    'mp_movimientos', 'mp_liquidaciones',
    'blindaje_documentos',
    'facturas', 'factura_items',
    'remitos',
    'rrhh_novedades', 'rrhh_liquidaciones',
    'rrhh_documentos', 'rrhh_historial_sueldos',
    'rrhh_pagos_especiales', 'rrhh_adelantos',
    'movimientos',
    'auditoria',
    'empleado_archivos'
  ];
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin puede ejecutar restore_tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND: tenant % no existe', p_tenant_id;
  END IF;
  IF p_backup_json IS NULL OR jsonb_typeof(p_backup_json) != 'object' THEN
    RAISE EXCEPTION 'BACKUP_INVALID: payload no es un objeto JSON';
  END IF;
  v_backup_tenant_id := NULLIF(p_backup_json->>'tenant_id', '')::uuid;
  v_backup_version := COALESCE((p_backup_json->>'version')::int, 0);
  IF v_backup_tenant_id IS NULL THEN
    RAISE EXCEPTION 'BACKUP_INVALID: missing tenant_id en el payload';
  END IF;
  IF v_backup_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'CROSS_TENANT_RESTORE_BLOCKED: backup tenant_id=% != target=%',
      v_backup_tenant_id, p_tenant_id;
  END IF;
  IF v_backup_version != 1 THEN
    RAISE EXCEPTION 'BACKUP_VERSION_UNSUPPORTED: version=%', v_backup_version;
  END IF;
  IF p_backup_json->'tablas' IS NULL OR jsonb_typeof(p_backup_json->'tablas') != 'object' THEN
    RAISE EXCEPTION 'BACKUP_INVALID: missing tablas object';
  END IF;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;
  FOREACH v_table_name IN ARRAY v_orden_delete LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name) THEN
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name) USING p_tenant_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_filas_borradas := v_filas_borradas + v_rows;
    END IF;
  END LOOP;
  FOREACH v_table_name IN ARRAY v_orden_insert LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name)
       AND p_backup_json->'tablas'->v_table_name IS NOT NULL
       AND jsonb_typeof(p_backup_json->'tablas'->v_table_name) = 'array'
       AND jsonb_array_length(p_backup_json->'tablas'->v_table_name) > 0 THEN
      EXECUTE format(
        'INSERT INTO %I SELECT * FROM jsonb_populate_recordset(NULL::%I, $1)',
        v_table_name, v_table_name
      ) USING (p_backup_json->'tablas'->v_table_name);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_filas_restauradas := v_filas_restauradas + v_rows;
    END IF;
  END LOOP;
  FOREACH v_table_name IN ARRAY v_orden_insert LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name) THEN
      BEGIN
        v_seq := pg_get_serial_sequence('public.'||v_table_name, 'id');
        IF v_seq IS NOT NULL THEN
          EXECUTE format(
            'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 1))',
            v_seq, v_table_name
          );
        END IF;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END LOOP;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;
  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'filas_borradas', v_filas_borradas,
    'filas_restauradas', v_filas_restauradas
  );
END;
$$;
