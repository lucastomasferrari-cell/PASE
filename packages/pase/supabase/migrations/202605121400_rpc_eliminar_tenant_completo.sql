-- ═══════════════════════════════════════════════════════════════════════════
-- RPC eliminar_tenant_completo(p_tenant_id uuid).
--
-- Borra un tenant junto con todas sus filas asociadas en una sola TX. Es la
-- contraparte simétrica de restore_tenant: usa el mismo orden topológico,
-- también desactiva los triggers append-only de auditoria mientras corre, y
-- los reactiva al final.
--
-- Motivación: la FK auditoria.tenant_id quedó con ON DELETE CASCADE
-- (migration 202605121300), pero los triggers trg_auditoria_no_delete y
-- trg_auditoria_no_update se disparan también durante el cascade y bloquean
-- el borrado del tenant. La única forma limpia desde un user authenticated es
-- una RPC SECURITY DEFINER que desactive los triggers temporalmente.
--
-- Usos previstos:
--   - Cleanup del test restore_tenant_mutante.
--   - Botón "Eliminar tenant" futuro en la UI superadmin (Tenants.tsx).
--
-- Validaciones (regla C11):
--   - auth_es_superadmin() en las primeras líneas → linter Supabase OK.
--   - Tenant existe.
--   - Bloqueo defensivo contra borrar al tenant del superadmin que invoca
--     (defensa anti pie-en-el-tornillo).
--
-- Atomicidad: la función entera corre en la TX implícita del caller. Si
-- cualquier statement falla, Postgres roll-back incluye los ALTER TABLE
-- DISABLE TRIGGER (semántica DDL transaccional), así que los triggers no
-- quedan desactivados al exterior. Mismo patrón usado en restore_tenant.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Orden inverso topológico (children primero). Mismo array que
  -- restore_tenant para mantener invariantes simétricas.
  v_orden_delete text[] := ARRAY[
    'empleado_archivos',
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
BEGIN
  -- ─── 1. Validar permisos (regla C11) ─────────────────────────────────────
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo superadmin puede ejecutar eliminar_tenant_completo';
  END IF;

  -- ─── 2. Validar tenant existe ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND: tenant % no existe', p_tenant_id;
  END IF;

  -- ─── 3. Bloqueo anti pie-en-el-tornillo ──────────────────────────────────
  -- Si el superadmin tiene tenant_id propio (caso histórico — antes del
  -- sprint multi-tenant, Lucas era dueño de Neko y superadmin a la vez),
  -- prevenimos que se borre el tenant en el que él mismo está.
  SELECT tenant_id INTO v_caller_tenant FROM usuarios WHERE auth_id = v_caller_uid;
  IF v_caller_tenant IS NOT NULL AND v_caller_tenant = p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_ES_DEL_CALLER: no podés borrar el tenant en el que estás autenticado';
  END IF;

  -- ─── 4. Desactivar triggers append-only de auditoria ─────────────────────
  -- Sin esto, el DELETE en auditoria (paso 5) tira AUDITORIA_INMUTABLE.
  -- Si la función falla más adelante, el rollback DDL los reactiva.
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  -- ─── 5. Borrar auditoria del tenant ──────────────────────────────────────
  -- Va separada porque el CASCADE de la FK no la libera (los triggers la
  -- bloquearían igual cuando dispara el cascade).
  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── 6. DELETE en orden inverso topológico ───────────────────────────────
  FOREACH v_table_name IN ARRAY v_orden_delete LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name) THEN
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name)
        USING p_tenant_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_filas_borradas := v_filas_borradas + v_rows;
    END IF;
  END LOOP;

  -- ─── 7. Borrar la fila del tenant (tenant_admins se borra por CASCADE) ───
  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── 8. Reactivar triggers append-only ───────────────────────────────────
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

GRANT EXECUTE ON FUNCTION eliminar_tenant_completo(uuid) TO authenticated;
REVOKE ALL ON FUNCTION eliminar_tenant_completo(uuid) FROM PUBLIC;
