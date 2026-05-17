-- ═══════════════════════════════════════════════════════════════════════════
-- Fase 4.4 offline-first — variantes `_offline` de pagos + overrides + transfer
--
-- Wrappers que aceptan p_idempotency_uuid (UUID generado client-side) y
-- p_*_idempotency_uuid para referenciar venta/item creados offline antes
-- de tener BIGINT real. Cada RPC valida idempotency contra una columna
-- nueva idempotency_uuid (única) para que retries no dupliquen.
--
-- Patrón uniforme:
--   1. Si p_idempotency_uuid YA existe en la tabla relevante → retornar
--      el resultado anterior (dedup).
--   2. Resolver venta_id desde uuid si vino así (fn_resolver_venta_id_por_uuid
--      ya existe de migration 202605161400).
--   3. Idem para item_id desde fn_resolver_venta_item_id_por_uuid (nuevo acá).
--   4. Ejecutar la lógica original con los ids resueltos.
--   5. Persistir idempotency_uuid donde aplique (overrides table).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Columnas idempotency_uuid en tablas que faltan ────────────────────────
ALTER TABLE ventas_pos_pagos
  ADD COLUMN IF NOT EXISTS idempotency_uuid UUID NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_pos_pagos_idempotency_uuid
  ON ventas_pos_pagos(idempotency_uuid)
  WHERE idempotency_uuid IS NOT NULL;

ALTER TABLE ventas_pos_overrides
  ADD COLUMN IF NOT EXISTS idempotency_uuid UUID NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_pos_overrides_idempotency_uuid
  ON ventas_pos_overrides(idempotency_uuid)
  WHERE idempotency_uuid IS NOT NULL;

-- ─── Helper para resolver item_id desde idempotency_uuid ───────────────────
CREATE OR REPLACE FUNCTION fn_resolver_venta_item_id_por_uuid(
  p_item_id BIGINT,
  p_item_uuid UUID
) RETURNS BIGINT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_resolved BIGINT;
BEGIN
  IF p_item_id IS NOT NULL THEN
    RETURN p_item_id;
  END IF;
  IF p_item_uuid IS NULL THEN
    RAISE EXCEPTION 'ITEM_REFERENCIA_FALTANTE: se requiere item_id o item_idempotency_uuid';
  END IF;
  SELECT id INTO v_resolved FROM ventas_pos_items WHERE idempotency_uuid = p_item_uuid;
  IF v_resolved IS NULL THEN
    RAISE EXCEPTION 'ITEM_NO_SINCRONIZADO: el UUID % no existe en server (client reintenta)', p_item_uuid;
  END IF;
  RETURN v_resolved;
END;
$$;

REVOKE ALL ON FUNCTION fn_resolver_venta_item_id_por_uuid(BIGINT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_resolver_venta_item_id_por_uuid(BIGINT, UUID) TO authenticated, service_role;

-- ─── fn_cobrar_venta_comanda_offline ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cobrar_venta_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_pagos JSONB,
  p_propina NUMERIC DEFAULT 0,
  p_cobrado_por UUID DEFAULT NULL,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  -- Delegamos al fn_cobrar_venta_comanda existente. La idempotencia interna
  -- por header (cobro_idempotency_key) ya maneja retries.
  RETURN fn_cobrar_venta_comanda(
    v_venta_id, p_pagos, p_propina, p_cobrado_por,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT)
  );
END;
$$;

REVOKE ALL ON FUNCTION fn_cobrar_venta_comanda_offline(
  BIGINT, UUID, JSONB, NUMERIC, UUID, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cobrar_venta_comanda_offline(
  BIGINT, UUID, JSONB, NUMERIC, UUID, UUID, TEXT
) TO authenticated;

-- ─── fn_anular_item_comanda_offline ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_anular_item_comanda_offline(
  p_item_id BIGINT,
  p_item_idempotency_uuid UUID,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item_id BIGINT;
  v_dedup_id BIGINT;
  v_override_id BIGINT;
BEGIN
  -- Dedup por idempotency_uuid en overrides
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_dedup_id FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN RETURN; END IF;
  END IF;
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);
  -- Delegar al fn_anular_item existente con el idempotency_key string
  PERFORM fn_anular_item(v_item_id, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
  -- Marcar el override recién creado con el uuid (Postgres no soporta LIMIT
  -- en UPDATE, así que capturamos el id antes y updateamos por id).
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_override_id FROM ventas_pos_overrides
      WHERE venta_item_id = v_item_id AND accion = 'void'
        AND idempotency_uuid IS NULL
      ORDER BY id DESC LIMIT 1;
    IF v_override_id IS NOT NULL THEN
      UPDATE ventas_pos_overrides SET idempotency_uuid = p_idempotency_uuid
        WHERE id = v_override_id;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_anular_item_comanda_offline(
  BIGINT, UUID, UUID, TEXT, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_anular_item_comanda_offline(
  BIGINT, UUID, UUID, TEXT, UUID, TEXT
) TO authenticated;

-- ─── fn_cortesia_item_comanda_offline ──────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cortesia_item_comanda_offline(
  p_item_id BIGINT,
  p_item_idempotency_uuid UUID,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item_id BIGINT;
  v_dedup_id BIGINT;
  v_override_id BIGINT;
BEGIN
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_dedup_id FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN RETURN; END IF;
  END IF;
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);
  PERFORM fn_cortesia_item(v_item_id, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_override_id FROM ventas_pos_overrides
      WHERE venta_item_id = v_item_id AND accion = 'comp'
        AND idempotency_uuid IS NULL
      ORDER BY id DESC LIMIT 1;
    IF v_override_id IS NOT NULL THEN
      UPDATE ventas_pos_overrides SET idempotency_uuid = p_idempotency_uuid
        WHERE id = v_override_id;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_cortesia_item_comanda_offline(
  BIGINT, UUID, UUID, TEXT, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cortesia_item_comanda_offline(
  BIGINT, UUID, UUID, TEXT, UUID, TEXT
) TO authenticated;

-- ─── fn_modificar_precio_item_comanda_offline ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_modificar_precio_item_comanda_offline(
  p_item_id BIGINT,
  p_item_idempotency_uuid UUID,
  p_precio_nuevo NUMERIC,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item_id BIGINT;
  v_dedup_id BIGINT;
  v_override_id BIGINT;
BEGIN
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_dedup_id FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN RETURN; END IF;
  END IF;
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);
  PERFORM fn_modificar_precio_item(v_item_id, p_precio_nuevo, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_override_id FROM ventas_pos_overrides
      WHERE venta_item_id = v_item_id AND accion = 'discount'
        AND idempotency_uuid IS NULL
      ORDER BY id DESC LIMIT 1;
    IF v_override_id IS NOT NULL THEN
      UPDATE ventas_pos_overrides SET idempotency_uuid = p_idempotency_uuid
        WHERE id = v_override_id;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_modificar_precio_item_comanda_offline(
  BIGINT, UUID, NUMERIC, UUID, TEXT, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_modificar_precio_item_comanda_offline(
  BIGINT, UUID, NUMERIC, UUID, TEXT, UUID, TEXT
) TO authenticated;

-- ─── fn_aplicar_descuento_comanda_offline ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_monto NUMERIC,
  p_motivo TEXT,
  p_manager_id UUID DEFAULT NULL,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  PERFORM fn_aplicar_descuento_comanda(v_venta_id, p_monto, p_motivo, p_manager_id,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
END;
$$;

REVOKE ALL ON FUNCTION fn_aplicar_descuento_comanda_offline(
  BIGINT, UUID, NUMERIC, TEXT, UUID, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_aplicar_descuento_comanda_offline(
  BIGINT, UUID, NUMERIC, TEXT, UUID, UUID, TEXT
) TO authenticated;

-- ─── fn_anular_venta_comanda_offline ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_anular_venta_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  PERFORM fn_anular_venta(v_venta_id, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
END;
$$;

REVOKE ALL ON FUNCTION fn_anular_venta_comanda_offline(
  BIGINT, UUID, UUID, TEXT, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_anular_venta_comanda_offline(
  BIGINT, UUID, UUID, TEXT, UUID, TEXT
) TO authenticated;

-- ─── fn_transferir_mesa_comanda_offline ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_transferir_mesa_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_mesa_destino_id INTEGER,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  PERFORM fn_transferir_mesa_comanda(v_venta_id, p_mesa_destino_id);
END;
$$;

REVOKE ALL ON FUNCTION fn_transferir_mesa_comanda_offline(
  BIGINT, UUID, INTEGER, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_transferir_mesa_comanda_offline(
  BIGINT, UUID, INTEGER, UUID, TEXT
) TO authenticated;

-- ─── fn_unir_mesas_comanda_offline ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_unir_mesas_comanda_offline(
  p_venta_destino_id BIGINT,
  p_venta_destino_idempotency_uuid UUID,
  p_venta_origen_id BIGINT,
  p_venta_origen_idempotency_uuid UUID,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_destino BIGINT;
  v_origen BIGINT;
BEGIN
  v_destino := fn_resolver_venta_id_por_uuid(p_venta_destino_id, p_venta_destino_idempotency_uuid);
  v_origen := fn_resolver_venta_id_por_uuid(p_venta_origen_id, p_venta_origen_idempotency_uuid);
  PERFORM fn_unir_mesas_comanda(v_destino, v_origen);
END;
$$;

REVOKE ALL ON FUNCTION fn_unir_mesas_comanda_offline(
  BIGINT, UUID, BIGINT, UUID, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_unir_mesas_comanda_offline(
  BIGINT, UUID, BIGINT, UUID, UUID, TEXT
) TO authenticated;

-- ─── fn_partir_cuenta_comanda_offline ──────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_partir_cuenta_comanda_offline(
  p_venta_original_id BIGINT,
  p_venta_original_idempotency_uuid UUID,
  p_item_ids BIGINT[],
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_original_id BIGINT;
BEGIN
  v_venta_original_id := fn_resolver_venta_id_por_uuid(p_venta_original_id, p_venta_original_idempotency_uuid);
  -- fn_partir_cuenta_comanda retorna el BIGINT de la venta nueva creada.
  RETURN fn_partir_cuenta_comanda(v_venta_original_id, p_item_ids);
END;
$$;

REVOKE ALL ON FUNCTION fn_partir_cuenta_comanda_offline(
  BIGINT, UUID, BIGINT[], UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_partir_cuenta_comanda_offline(
  BIGINT, UUID, BIGINT[], UUID, TEXT
) TO authenticated;

NOTIFY pgrst, 'reload schema';
