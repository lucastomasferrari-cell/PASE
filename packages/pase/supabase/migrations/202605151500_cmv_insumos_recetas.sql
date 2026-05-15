-- ═══════════════════════════════════════════════════════════════════════════
-- F1.1 — Modelo CMV: insumos + recetas + receta_insumos
--
-- Contexto: auditoría estructural 2026-05-15 detectó que CMV = 0% (una de las
-- 4 metas del producto sin cimientos). Esta migration sienta las tablas
-- canónicas que habilitan luego (a) UI editor recetas, (b) cruce ventas×recetas
-- para consumo teórico, (c) reporte CMV.
--
-- DECISIÓN — drop de tablas legacy (Lucas confirmó 2026-05-15):
-- Existían 5 tablas legacy de un módulo "Insumos" eliminado tiempo atrás:
-- insumos, recetas, receta_items, factura_items_stock, remito_items.
-- TODAS estaban vacías (0 filas) y NINGÚN frontend las usaba. Las únicas
-- referencias eran en RPCs de backup/restore (restore_tenant + eliminar_tenant_completo)
-- que listan todas las tablas para dump/cleanup. Dropeamos las 5 con CASCADE
-- y recreamos `insumos` + `recetas` con schema nuevo, y `receta_insumos` como
-- la m:n correcta.
--
-- Modelo:
--   - `insumos`: catálogo canónico de ingredientes (tenant-scoped, opcional
--     per-local). Unidad obligatoria. Precio promedio se calcula a partir de
--     compras (Fase 1.2 PASE = vincular factura_items a insumo_id) — por
--     ahora la columna existe pero se llena manual o por job futuro.
--   - `recetas`: receta VIVA (editable) por item. UNIQUE por item — solo 1
--     receta activa simultánea. Si cambia, se crea nueva receta + se snapshot
--     la vieja en `recetas_versiones` (ya existente como inmutable, sprint 1).
--   - `receta_insumos`: relación m:n con cantidad + merma %. UNIQUE
--     (receta_id, insumo_id, notas).
--   - `items.receta_id_vigente`: FK a `recetas` (la viva activa).
--
-- Cumple C1/C7/C11:
--   - tenant_id, created_at, updated_at, RLS dual.
--   - RPC fn_snapshot_receta_a_version es SECURITY DEFINER con auth check.
--   - Soft delete (deleted_at) para auditoría.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 0. DROP de tablas legacy (todas vacías) ───────────────────────────────
-- CASCADE arrastra los foreign keys + constraints. Si hubiera columnas
-- referenciándolas en tablas activas, esas columnas quedarían rotas — por eso
-- la auditoría previa confirmó que NO había uso desde frontend.
DROP TABLE IF EXISTS receta_items CASCADE;
DROP TABLE IF EXISTS factura_items_stock CASCADE;
DROP TABLE IF EXISTS remito_items CASCADE;
DROP TABLE IF EXISTS recetas CASCADE;
DROP TABLE IF EXISTS insumos CASCADE;

-- ─── 1. Tabla insumos ──────────────────────────────────────────────────────
CREATE TABLE insumos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id), -- NULL = catálogo global del tenant
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  nombre        TEXT NOT NULL,
  descripcion   TEXT NULL,
  emoji         TEXT NULL,
  foto_url      TEXT NULL,

  -- Unidad de medida canónica. Cualquier conversión (ej. kg → g) se hace
  -- en el cliente o en una vista. La idea es que TODO uso del insumo en
  -- recetas use la misma unidad para no liarse.
  -- 'porcion' es para insumos pre-procesados que se compran en unidades
  -- discretas (ej. 1 hamburguesa pre-cocida).
  unidad        TEXT NOT NULL CHECK (unidad IN ('kg', 'g', 'L', 'ml', 'un', 'porcion')),

  -- Costo unitario actual (por unidad de la columna anterior).
  -- Lo llena un job de Fase 1.2 PASE cuando vincule factura_items.insumo_id.
  -- Por ahora se puede setear manual desde la UI.
  costo_actual          NUMERIC(12,4) NULL,
  costo_actualizado_at  TIMESTAMPTZ NULL,
  -- Costo histórico promedio (últimos N días o ponderado por volumen).
  costo_promedio_30d    NUMERIC(12,4) NULL,

  -- Proveedor preferido opcional (info, no constraint).
  proveedor_preferido_id INTEGER NULL,

  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Indica si este insumo se compra (true) o se produce internamente como
  -- sub-receta (false). Las sub-recetas (mayonesa casera) son insumos cuyo
  -- costo se calcula a partir de OTRA receta — feature de Fase futura.
  es_comprado   BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT chk_insumo_nombre_no_vacio CHECK (length(trim(nombre)) > 0),
  CONSTRAINT chk_insumo_costo_no_negativo CHECK (
    costo_actual IS NULL OR costo_actual >= 0
  )
);
-- UNIQUE parcial: nombre único por (tenant, local) entre los NO borrados.
-- COALESCE(local_id, -1) maneja el caso global (local_id IS NULL).
CREATE UNIQUE INDEX uniq_insumo_tenant_local_nombre
  ON insumos(tenant_id, COALESCE(local_id, -1), nombre)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_insumos_tenant_activo
  ON insumos(tenant_id, activo) WHERE deleted_at IS NULL;
CREATE INDEX idx_insumos_local_id
  ON insumos(local_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_insumos_set_updated_at BEFORE UPDATE ON insumos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE insumos IS
  'Catálogo canónico de ingredientes para CMV (F1.1, 2026-05-15). local_id NULL = catálogo global del tenant; local_id specific = override local. costo_actual lo llena Fase 1.2 PASE (vincular factura_items.insumo_id).';

-- ─── 2. Tabla recetas (vivas/editables) ────────────────────────────────────
CREATE TABLE recetas (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id), -- NULL = receta global del tenant
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  item_id       INTEGER NOT NULL REFERENCES items(id),
  nombre        TEXT NOT NULL,
  -- Yield/rendimiento: cuántas porciones produce ESTA receta entera.
  -- Para item simple (1 hamburguesa = 1 receta), rendimiento = 1.
  -- Para batch (5L salsa con un proceso) = N.
  rendimiento   NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (rendimiento > 0),
  notas         TEXT NULL,
  activa        BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT chk_receta_nombre_no_vacio CHECK (length(trim(nombre)) > 0)
);
-- Solo 1 receta activa por (tenant, local, item). Si cambia, se desactiva la
-- vieja (snapshot en recetas_versiones) y se crea una nueva.
CREATE UNIQUE INDEX uniq_receta_activa_por_item
  ON recetas(tenant_id, COALESCE(local_id, -1), item_id)
  WHERE activa = TRUE AND deleted_at IS NULL;
CREATE INDEX idx_recetas_item
  ON recetas(item_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_recetas_set_updated_at BEFORE UPDATE ON recetas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE recetas IS
  'Recetas vivas (editables) por item. UNIQUE constraint asegura solo 1 receta activa simultánea. Para snapshot inmutable al momento de venta, ver recetas_versiones (sprint 1).';

-- ─── 3. Tabla receta_insumos (m:n) ─────────────────────────────────────────
CREATE TABLE receta_insumos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  receta_id     BIGINT NOT NULL REFERENCES recetas(id),
  insumo_id     BIGINT NOT NULL REFERENCES insumos(id),
  -- Cantidad por receta entera. Para porción individual, dividir por
  -- recetas.rendimiento.
  cantidad      NUMERIC(12,4) NOT NULL CHECK (cantidad > 0),
  -- merma_pct: porcentaje de pérdida típica. El cálculo de CMV multiplica
  -- cantidad × (1 + merma_pct/100). Default 0%.
  merma_pct     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (merma_pct >= 0 AND merma_pct <= 100),
  notas         TEXT NULL,
  orden         INTEGER NOT NULL DEFAULT 0
);
-- UNIQUE permite el mismo insumo dos veces en una receta SOLO si tiene notas
-- distintas (caso raro). En la práctica 99% solo 1 fila por (receta_id, insumo_id).
CREATE UNIQUE INDEX uniq_receta_insumo
  ON receta_insumos(receta_id, insumo_id, COALESCE(notas, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX idx_receta_insumos_receta
  ON receta_insumos(receta_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_receta_insumos_insumo
  ON receta_insumos(insumo_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_receta_insumos_set_updated_at BEFORE UPDATE ON receta_insumos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE receta_insumos IS
  'Cantidad de cada insumo en cada receta. cantidad = por receta entera (dividir por rendimiento para por-porción). merma_pct = 0..100, default 0.';

-- ─── 4. FK desde items.receta_id_vigente (a receta viva, no a snapshot) ────
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS receta_id_vigente BIGINT NULL REFERENCES recetas(id);
COMMENT ON COLUMN items.receta_id_vigente IS
  'FK a recetas (receta viva editable). items.receta_version_id_vigente sigue siendo el snapshot inmutable usado por las ventas ya cobradas.';

-- ─── 5. RLS dual (auth + service) ──────────────────────────────────────────
ALTER TABLE insumos ENABLE ROW LEVEL SECURITY;
ALTER TABLE recetas ENABLE ROW LEVEL SECURITY;
ALTER TABLE receta_insumos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insumos_select ON insumos;
CREATE POLICY insumos_select ON insumos FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );
DROP POLICY IF EXISTS insumos_modify ON insumos;
CREATE POLICY insumos_modify ON insumos FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  );
DROP POLICY IF EXISTS insumos_service ON insumos;
CREATE POLICY insumos_service ON insumos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS recetas_select ON recetas;
CREATE POLICY recetas_select ON recetas FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );
DROP POLICY IF EXISTS recetas_modify ON recetas;
CREATE POLICY recetas_modify ON recetas FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  );
DROP POLICY IF EXISTS recetas_service ON recetas;
CREATE POLICY recetas_service ON recetas FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS receta_insumos_select ON receta_insumos;
CREATE POLICY receta_insumos_select ON receta_insumos FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR EXISTS (
      SELECT 1 FROM recetas r WHERE r.id = receta_insumos.receta_id
        AND r.tenant_id = auth_tenant_id()
        AND (r.local_id IS NULL OR r.local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );
DROP POLICY IF EXISTS receta_insumos_modify ON receta_insumos;
CREATE POLICY receta_insumos_modify ON receta_insumos FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('compras'))
  );
DROP POLICY IF EXISTS receta_insumos_service ON receta_insumos;
CREATE POLICY receta_insumos_service ON receta_insumos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── 6. RPC: snapshot de receta viva a versión inmutable ──────────────────
CREATE OR REPLACE FUNCTION fn_snapshot_receta_a_version(
  p_item_id INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_receta RECORD;
  v_receta_data JSONB;
  v_existing_id BIGINT;
  v_next_version INTEGER;
  v_new_id BIGINT;
BEGIN
  -- C11 auth check primero.
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;

  -- Buscar receta viva activa para el item. Si hay >1 (global + local override),
  -- preferir la local del usuario actual.
  SELECT r.* INTO v_receta
  FROM recetas r
  WHERE r.item_id = p_item_id
    AND r.activa = TRUE
    AND r.deleted_at IS NULL
    AND (auth_es_superadmin() OR r.tenant_id = v_tenant_id)
  ORDER BY r.local_id NULLS LAST -- prefiere local sobre global
  LIMIT 1;

  IF v_receta IS NULL THEN
    -- Item sin receta — devolvemos NULL (la venta se cobra igual, sin CMV).
    RETURN NULL;
  END IF;

  -- Componer JSONB con la receta + sus insumos.
  SELECT jsonb_build_object(
    'receta_id', v_receta.id,
    'receta_nombre', v_receta.nombre,
    'rendimiento', v_receta.rendimiento,
    'snapshot_at', NOW(),
    'insumos', COALESCE(jsonb_agg(jsonb_build_object(
      'insumo_id', ri.insumo_id,
      'insumo_nombre', i.nombre,
      'insumo_unidad', i.unidad,
      'cantidad', ri.cantidad,
      'merma_pct', ri.merma_pct,
      'costo_unitario_snapshot', i.costo_actual,
      'notas', ri.notas
    ) ORDER BY ri.orden, ri.id) FILTER (WHERE ri.id IS NOT NULL), '[]'::jsonb)
  ) INTO v_receta_data
  FROM (SELECT v_receta.id AS rid) r
  LEFT JOIN receta_insumos ri ON ri.receta_id = r.rid AND ri.deleted_at IS NULL
  LEFT JOIN insumos i ON i.id = ri.insumo_id;

  -- Idempotency: si existe version con mismo receta_data, reusarla.
  SELECT id INTO v_existing_id
  FROM recetas_versiones
  WHERE item_id = p_item_id
    AND receta_data = v_receta_data
  ORDER BY version_numero DESC
  LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Calcular próximo version_numero para este item.
  SELECT COALESCE(MAX(version_numero), 0) + 1 INTO v_next_version
  FROM recetas_versiones
  WHERE item_id = p_item_id;

  INSERT INTO recetas_versiones (tenant_id, item_id, version_numero, receta_data, notas)
  VALUES (
    COALESCE(v_tenant_id, v_receta.tenant_id),
    p_item_id,
    v_next_version,
    v_receta_data,
    'Snapshot auto-generado por fn_snapshot_receta_a_version'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_snapshot_receta_a_version FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_snapshot_receta_a_version TO authenticated, service_role;

COMMENT ON FUNCTION fn_snapshot_receta_a_version IS
  'F1.1: snapshot inmutable de receta viva al momento de cobro. Idempotente por contenido. Llamada desde RPC fn_cobrar_venta_comanda en cada item con receta vigente.';

-- ─── 7. Actualizar arrays en eliminar_tenant_completo + restore_tenant ────
-- Tienen v_orden_delete y v_orden_insert con las tablas legacy ya dropeadas.
-- Sacarlas + agregar las nuevas en el lugar topológico correcto.

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
    -- F1.1: CMV en orden topológico (children primero).
    'receta_insumos', 'recetas', 'insumos',
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
    -- F1.1: parents primero (insumos sin FK a recetas; recetas FK a items;
    -- receta_insumos FK a recetas+insumos).
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

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN F1.1
-- ═══════════════════════════════════════════════════════════════════════════
