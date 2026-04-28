-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.17 — ETAPA 3: RPC restore_tenant.
--
-- SECURITY DEFINER, solo superadmin. Restaura un tenant a un punto-en-el-
-- tiempo desde un backup JSON producido por api/backup-tenants.js.
--
-- Firma: restore_tenant(p_tenant_id uuid, p_backup_path text, p_backup_json jsonb).
-- Postgres no tiene gunzip nativo y pg_net complica el flujo, así que el
-- frontend (o el endpoint API) descarga + descomprime el .gz y pasa el
-- JSON parseado al RPC. p_backup_path solo se audita.
--
-- Validaciones críticas:
--   - Caller es superadmin (auth_es_superadmin()).
--   - Tenant existe.
--   - JSON tiene shape válido (version=1, tenant_id presente).
--   - Anti cross-tenant: backup.tenant_id == p_tenant_id (si no, ABORT).
--
-- Atomicidad: una sola transacción. DELETE en orden inverso topológico,
-- INSERT en orden directo, setval de secuencias post-INSERT, audit.
--
-- Triggers append-only de auditoria se desactivan dentro de la TX y se
-- reactivan antes del COMMIT — rollback-safe.
--
-- Storage: el RPC NO toca buckets físicos. Los archivos del tenant
-- (facturas/blindaje/rrhh-documentos) quedan como estaban antes del
-- restore. Los storage_paths del backup son solo referencia.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION restore_tenant(
  p_tenant_id uuid,
  p_backup_path text,
  p_backup_json jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Caller (superadmin que dispara el restore).
  v_caller_uid uuid := auth.uid();

  -- Metadata del backup.
  v_backup_tenant_id uuid;
  v_backup_version int;

  -- Counters.
  v_filas_borradas bigint := 0;
  v_filas_restauradas bigint := 0;
  v_rows int;

  -- Iteración de tablas.
  v_table_name text;
  v_seq text;

  -- Orden inverso topológico (children primero).
  v_orden_delete text[] := ARRAY[
    'empleado_archivos',
    'auditoria',
    'movimientos',
    'rrhh_adelantos', 'rrhh_pagos_especiales', 'rrhh_historial_sueldos',
    'rrhh_documentos', 'rrhh_liquidaciones', 'rrhh_novedades',
    'remito_items', 'remitos',
    'factura_items_stock', 'factura_items', 'facturas',
    'blindaje_documentos',
    'mp_liquidaciones', 'mp_movimientos',
    'caja_efectivo', 'saldos_caja',
    'gastos_plantillas', 'gastos', 'ventas',
    'rrhh_empleados', 'mp_credenciales',
    'receta_items', 'recetas',
    'medios_cobro', 'blindaje_tipos_documento', 'rrhh_valores_doble',
    'config_categorias', 'insumos', 'proveedores',
    'tenant_admins',
    'usuario_permisos', 'usuario_locales',
    'locales', 'usuarios'
  ];

  -- Orden directo topológico (parents primero).
  v_orden_insert text[] := ARRAY[
    'usuarios', 'locales',
    'usuario_locales', 'usuario_permisos', 'tenant_admins',
    'proveedores', 'insumos', 'config_categorias',
    'rrhh_valores_doble', 'blindaje_tipos_documento', 'medios_cobro',
    'recetas', 'receta_items',
    'mp_credenciales', 'rrhh_empleados',
    'ventas', 'gastos', 'gastos_plantillas',
    'saldos_caja', 'caja_efectivo',
    'mp_movimientos', 'mp_liquidaciones',
    'blindaje_documentos',
    'facturas', 'factura_items', 'factura_items_stock',
    'remitos', 'remito_items',
    'rrhh_novedades', 'rrhh_liquidaciones',
    'rrhh_documentos', 'rrhh_historial_sueldos',
    'rrhh_pagos_especiales', 'rrhh_adelantos',
    'movimientos',
    'auditoria',
    'empleado_archivos'
  ];
BEGIN
  -- ─── 1. Validar permisos ─────────────────────────────────────────────────
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin puede ejecutar restore_tenant';
  END IF;

  -- ─── 2. Validar tenant existe ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND: tenant % no existe', p_tenant_id;
  END IF;

  -- ─── 3. Validar shape del backup ─────────────────────────────────────────
  IF p_backup_json IS NULL OR jsonb_typeof(p_backup_json) != 'object' THEN
    RAISE EXCEPTION 'BACKUP_INVALID: payload no es un objeto JSON';
  END IF;

  v_backup_tenant_id := NULLIF(p_backup_json->>'tenant_id', '')::uuid;
  v_backup_version := COALESCE((p_backup_json->>'version')::int, 0);

  IF v_backup_tenant_id IS NULL THEN
    RAISE EXCEPTION 'BACKUP_INVALID: missing tenant_id en el payload';
  END IF;

  -- Anti cross-tenant restore.
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

  -- ─── 4. Desactivar triggers append-only de auditoria ─────────────────────
  -- Mismo patrón que la migration 202604281201 — los triggers bloquean
  -- DELETE/UPDATE sobre auditoria. Si la TX falla, el rollback los
  -- reactiva por la semántica DDL transaccional de Postgres.
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  -- ─── 5. DELETE en orden inverso topológico ───────────────────────────────
  FOREACH v_table_name IN ARRAY v_orden_delete LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name) THEN
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name)
        USING p_tenant_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_filas_borradas := v_filas_borradas + v_rows;
    END IF;
  END LOOP;

  -- ─── 6. INSERT en orden directo topológico ───────────────────────────────
  -- jsonb_populate_recordset descarta keys que no existan en el row type.
  -- Si la tabla cambió de schema entre el backup y el restore (campo nuevo
  -- agregado después), las filas viejas se insertan sin esa columna y
  -- toman el DEFAULT — comportamiento seguro.
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

  -- ─── 7. Reajustar secuencias ─────────────────────────────────────────────
  -- Para cada tabla con PK 'id' SERIAL, setval al MAX(id) actual. Si la
  -- columna no es serial (uuid, PK compuesta, etc), pg_get_serial_sequence
  -- devuelve NULL y el bloque skip — defensive.
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
        -- Tabla sin columna 'id' o sin secuencia → skip silencioso.
        NULL;
      END;
    END IF;
  END LOOP;

  -- ─── 8. Reactivar triggers append-only ───────────────────────────────────
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;

  -- ─── 9. Auditoría del restore ────────────────────────────────────────────
  -- Se inserta DESPUÉS de re-insertar la propia auditoria del backup —
  -- queda como la fila más nueva post-restore, marcando que ese tenant
  -- pasó por un restore en esta fecha.
  INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
  VALUES (
    'tenants',
    'RESTORE_TENANT',
    jsonb_build_object(
      'backup_path', p_backup_path,
      'tenant_id', p_tenant_id,
      'filas_borradas', v_filas_borradas,
      'filas_restauradas', v_filas_restauradas,
      'restaurado_por_uid', v_caller_uid,
      'backup_version', v_backup_version
    )::text,
    now(),
    p_tenant_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'backup_path', p_backup_path,
    'filas_borradas', v_filas_borradas,
    'filas_restauradas', v_filas_restauradas
  );
END;
$$;

GRANT EXECUTE ON FUNCTION restore_tenant(uuid, text, jsonb) TO authenticated;

-- Revoke público (defensive, aunque por default no lo tiene).
REVOKE ALL ON FUNCTION restore_tenant(uuid, text, jsonb) FROM PUBLIC;
