-- ═══════════════════════════════════════════════════════════════════════════
-- Update eliminar_tenant_completo: agregar tablas creadas post-mayo
--
-- La RPC original (202605121400) cubría las tablas existentes al 12-may.
-- Desde entonces se agregaron muchas tablas con tenant_id que NO se incluyen
-- en el array de orden topológico → el DELETE final de tenants tira FK violation.
--
-- Detectado durante setup E2E Suite (22-may noche) cuando intentamos limpiar
-- el tenant de tests por primera vez → "items_tenant_id_fkey" violation.
--
-- Esta migration actualiza el array con TODAS las tablas con tenant_id de
-- prod al 22-may noche. Lista mantenida ordenada topológicamente: children
-- antes que parents (por FKs internas) y `tenants` siempre al final.
--
-- IMPORTANTE: cuando se cree una tabla nueva con tenant_id, AGREGAR al array
-- de abajo en la posición correcta. Sin esto los tests E2E + el flow real
-- de delete-tenant van a romper.
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

  -- Lista actualizada al 22-may 2026 noche. Children primero, parents después.
  -- Si agregás una tabla nueva con tenant_id, SUMALA acá.
  v_orden_delete text[] := ARRAY[
    -- Audit / log
    'auditoria_descartes', 'cron_dlq', 'idempotency_keys',
    -- Stock + insumos
    'insumo_movimientos', 'insumos_costo_historial', 'recetas_alertas_margen',
    'receta_insumos', 'receta_items', 'recetas_versiones', 'recetas',
    'insumos',
    -- Comanda POS (children → parents)
    'ventas_pos_overrides', 'ventas_pos_pagos', 'ventas_pos_items',
    'ventas_pos', 'turnos_caja', 'mesas', 'canales_history', 'canales',
    'item_precios_canal_history', 'item_precios_canal',
    'items_history', 'items', 'items_grupos',
    'comanda_local_settings',
    -- Tienda online + marketplace
    'pedidos_reviews',
    -- Mermas + manager override
    'mermas_motivos', 'manager_override_usos', 'tenant_totp_secret',
    -- Empleados / RRHH
    'empleado_archivos',
    'rrhh_adelantos', 'rrhh_pagos_especiales', 'rrhh_historial_sueldos',
    'rrhh_documentos', 'rrhh_liquidaciones', 'rrhh_novedades',
    'rrhh_pagos', 'rrhh_valores_doble', 'rrhh_empleados', 'rrhh_puestos',
    -- Movimientos financieros
    'movimientos',
    -- Compras + remitos + facturas
    'remito_items', 'remitos',
    'factura_items_stock', 'factura_items', 'facturas',
    'gastos_plantillas', 'gastos',
    -- Ventas legacy
    'ventas',
    -- MP / Conciliación
    'mp_liquidaciones', 'mp_movimientos', 'mp_credenciales', 'mp_justificaciones',
    'conciliaciones_mp', 'mp_webhooks_test',
    -- Banco
    'bank_statement_lines', 'bank_statements',
    -- Saldos + caja
    'caja_efectivo', 'saldos_caja', 'caja_movimientos_categorias', 'conceptos_caja',
    -- Blindaje
    'blindaje_documentos', 'blindaje_tipos_documento',
    -- Catálogos
    'medios_cobro', 'config_categorias',
    'proveedores',
    -- Instagram bot
    'ig_eventos', 'ig_mensajes', 'ig_conversaciones', 'ig_config',
    -- Push notifications
    'notification_preferences', 'admin_push_subscriptions',
    -- Soporte / tickets
    'tickets_soporte', 'dashboard_pinned_notes', 'manager_logbook',
    -- Print agents
    'print_agent_tokens', 'print_agents',
    -- Multi-tenant
    'tenant_admins', 'tenant_invoices',
    -- Usuarios
    'usuario_permisos', 'usuario_locales',
    -- Locales + usuarios (al final, son los parents principales)
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
  SELECT tenant_id INTO v_caller_tenant FROM usuarios WHERE auth_id = v_caller_uid;
  IF v_caller_tenant IS NOT NULL AND v_caller_tenant = p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_ES_DEL_CALLER: no podés borrar el tenant en el que estás autenticado';
  END IF;

  -- ─── 4. Desactivar triggers append-only de auditoria ─────────────────────
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_no_delete;

  -- ─── 5. Borrar auditoria del tenant ──────────────────────────────────────
  DELETE FROM auditoria WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── 6. DELETE en orden inverso topológico ───────────────────────────────
  FOREACH v_table_name IN ARRAY v_orden_delete LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table_name) THEN
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table_name)
          USING p_tenant_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_filas_borradas := v_filas_borradas + v_rows;
      EXCEPTION WHEN undefined_column THEN
        -- tabla existe pero no tiene tenant_id (ej. tablas globales) — skip
        NULL;
      END;
    END IF;
  END LOOP;

  -- ─── 7. Borrar tenant ─────────────────────────────────────────────────────
  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_filas_borradas := v_filas_borradas + v_rows;

  -- ─── 8. Reactivar triggers ────────────────────────────────────────────────
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_update;
  ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_no_delete;

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'filas_borradas', v_filas_borradas
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
