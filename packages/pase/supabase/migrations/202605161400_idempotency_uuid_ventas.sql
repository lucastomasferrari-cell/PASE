-- ═══════════════════════════════════════════════════════════════════════════
-- Fase 4 offline-first — Idempotency UUID + reconciliación de IDs locales
--
-- Permite que devices client-side generen UUIDs propios para operaciones
-- offline (abrir venta, agregar item, mandar curso) sin tener que cambiar
-- las PKs de las tablas (que siguen siendo BIGINT).
--
-- Patrón:
--   1. Client genera UUID v4 al ejecutar la op offline.
--   2. Client guarda local con tempId negativo + UUID en columna nueva.
--   3. Al sync, manda RPC con p_idempotency_uuid.
--   4. RPC valida: si ya existe row con ese UUID, retorna el BIGINT existente
--      (dedup natural). Si no existe, crea row nueva con BIGINT autoasignado
--      y guarda el UUID.
--   5. Client reconcilia: borra row con tempId, inserta con BIGINT real.
--
-- Cambios server-side:
--   - ALTER ventas_pos ADD COLUMN idempotency_uuid UUID UNIQUE NULL
--   - ALTER ventas_pos_items ADD COLUMN idempotency_uuid UUID UNIQUE NULL
--   - ALTER ventas_pos_items ADD COLUMN venta_idempotency_uuid UUID NULL
--     (referenciar venta cuando esta también es local-only)
--   - Modificar fn_abrir_venta_comanda + fn_agregar_item_comanda +
--     fn_mandar_curso_comanda para aceptar p_idempotency_uuid + opciones.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Columnas idempotency_uuid ──────────────────────────────────────────
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS idempotency_uuid UUID NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_pos_idempotency_uuid
  ON ventas_pos(idempotency_uuid)
  WHERE idempotency_uuid IS NOT NULL;

ALTER TABLE ventas_pos_items
  ADD COLUMN IF NOT EXISTS idempotency_uuid UUID NULL,
  ADD COLUMN IF NOT EXISTS venta_idempotency_uuid UUID NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_pos_items_idempotency_uuid
  ON ventas_pos_items(idempotency_uuid)
  WHERE idempotency_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ventas_pos_items_venta_uuid
  ON ventas_pos_items(venta_idempotency_uuid)
  WHERE venta_idempotency_uuid IS NOT NULL;

COMMENT ON COLUMN ventas_pos.idempotency_uuid IS
  'UUID generado por el device client-side al crear la venta offline. Server usa para dedup y reconciliación. NULL = creada online sin necesidad de dedup.';
COMMENT ON COLUMN ventas_pos_items.idempotency_uuid IS
  'UUID generado por el device client-side al crear el item offline.';
COMMENT ON COLUMN ventas_pos_items.venta_idempotency_uuid IS
  'UUID de la venta padre cuando el item se crea offline ANTES de que la venta esté sincronizada (venta_id real aún no asignado).';

-- ─── 2. Helper interno para resolver venta_id desde UUID ────────────────────
CREATE OR REPLACE FUNCTION fn_resolver_venta_id_por_uuid(
  p_venta_id BIGINT,
  p_venta_uuid UUID
) RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resolved BIGINT;
BEGIN
  -- Si pasan venta_id explícita, usar esa (modo online)
  IF p_venta_id IS NOT NULL THEN
    RETURN p_venta_id;
  END IF;
  -- Si no, buscar por UUID
  IF p_venta_uuid IS NULL THEN
    RAISE EXCEPTION 'VENTA_REFERENCIA_FALTANTE: se requiere venta_id o venta_idempotency_uuid';
  END IF;
  SELECT id INTO v_resolved FROM ventas_pos WHERE idempotency_uuid = p_venta_uuid;
  IF v_resolved IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_SINCRONIZADA: el UUID % no corresponde a ninguna venta del server (el client tiene que reintentar después)', p_venta_uuid;
  END IF;
  RETURN v_resolved;
END;
$$;

REVOKE ALL ON FUNCTION fn_resolver_venta_id_por_uuid(BIGINT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_resolver_venta_id_por_uuid(BIGINT, UUID) TO authenticated, service_role;

-- ─── 3. fn_abrir_venta_comanda con idempotency_uuid ─────────────────────────
-- Wrapper que extiende la RPC existente. Si p_idempotency_uuid está dado y
-- ya existe venta con ese UUID, retorna esa (dedup). Si no, crea nueva.
CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda_offline(
  p_local_id INTEGER,
  p_canal_id INTEGER,
  p_modo TEXT,
  p_mesa_id INTEGER DEFAULT NULL,
  p_mozo_id UUID DEFAULT NULL,
  p_cajero_id UUID DEFAULT NULL,
  p_cliente_id INTEGER DEFAULT NULL,
  p_covers INTEGER DEFAULT NULL,
  p_tab_nombre TEXT DEFAULT NULL,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL  -- sunny-creek C1, retrocompatible
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id BIGINT;
  v_new_id BIGINT;
BEGIN
  -- Dedup natural por idempotency_uuid
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM ventas_pos WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- Auth checks
  IF auth_tenant_id() IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  PERFORM fn_assert_local_autorizado(p_local_id);

  -- Insert nueva venta. numero_local lo asigna trigger autoincrement.
  INSERT INTO ventas_pos (
    tenant_id, local_id, canal_id, modo, mesa_id,
    mozo_id, cajero_id, cliente_id, covers, tab_nombre,
    estado, abierta_at, idempotency_uuid
  ) VALUES (
    auth_tenant_id(), p_local_id, p_canal_id, p_modo, p_mesa_id,
    p_mozo_id, p_cajero_id, p_cliente_id, p_covers, p_tab_nombre,
    'abierta', NOW(), p_idempotency_uuid
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_abrir_venta_comanda_offline(
  INTEGER, INTEGER, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER, TEXT, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_abrir_venta_comanda_offline(
  INTEGER, INTEGER, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER, TEXT, UUID, TEXT
) TO authenticated;

-- ─── 4. fn_agregar_item_comanda_offline ─────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_agregar_item_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_item_id INTEGER,
  p_cantidad NUMERIC,
  p_precio_unitario NUMERIC,
  p_curso INTEGER DEFAULT 1,
  p_modificadores JSONB DEFAULT NULL,
  p_notas TEXT DEFAULT NULL,
  p_cargado_por UUID DEFAULT NULL,
  p_idempotency_uuid UUID DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_existing_id BIGINT;
  v_new_id BIGINT;
  v_local_id INTEGER;
  v_tenant UUID;
BEGIN
  -- Dedup por idempotency_uuid
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM ventas_pos_items WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- Resolver venta_id (puede venir directo o vía UUID)
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);

  -- Auth check sobre el local de la venta resuelta
  SELECT local_id, tenant_id INTO v_local_id, v_tenant
    FROM ventas_pos WHERE id = v_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  INSERT INTO ventas_pos_items (
    tenant_id, local_id, venta_id, item_id, cantidad,
    precio_unitario, subtotal, curso, modificadores, notas,
    cargado_por, estado, idempotency_uuid, venta_idempotency_uuid
  ) VALUES (
    v_tenant, v_local_id, v_venta_id, p_item_id, p_cantidad,
    p_precio_unitario, p_cantidad * p_precio_unitario, p_curso, p_modificadores, p_notas,
    p_cargado_por, 'hold', p_idempotency_uuid, p_venta_idempotency_uuid
  )
  RETURNING id INTO v_new_id;

  -- Recalcular total venta
  PERFORM fn_recalc_total_venta(v_venta_id);

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_agregar_item_comanda_offline(
  BIGINT, UUID, INTEGER, NUMERIC, NUMERIC, INTEGER, JSONB, TEXT, UUID, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_agregar_item_comanda_offline(
  BIGINT, UUID, INTEGER, NUMERIC, NUMERIC, INTEGER, JSONB, TEXT, UUID, UUID
) TO authenticated;

-- ─── 5. fn_mandar_curso_comanda_offline ─────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_mandar_curso_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_curso INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
  v_count INTEGER;
  v_local_id INTEGER;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);

  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = v_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos_items SET
    estado = 'enviado', enviado_at = NOW(), updated_at = NOW()
  WHERE venta_id = v_venta_id AND curso = p_curso
    AND estado = 'hold'
    AND stay_until_release = FALSE
    AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION fn_mandar_curso_comanda_offline(BIGINT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mandar_curso_comanda_offline(BIGINT, UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
