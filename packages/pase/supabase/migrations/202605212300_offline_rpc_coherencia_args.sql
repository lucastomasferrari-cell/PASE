-- ═══════════════════════════════════════════════════════════════════════════
-- CRIT-9 Auditoría 2026-05-21: RPCs _offline validar coherencia args
--
-- Bug: las RPCs offline (fn_anular_item_comanda_offline, fn_cortesia_item_*,
-- fn_modificar_precio_item_*) dedupean por idempotency_uuid retornando OK
-- silencioso si ya fue consumido. Pero NO validan que el item_id/uuid del
-- request actual coincida con el del cache. Resultado: cliente buggy o
-- malicioso reusa el mismo UUID para anular items diferentes, server
-- responde OK pero el item nuevo NO se anula → cobro indebido.
--
-- Fix: en el dedup, además del UUID, validar que venta_item_id matchea.
-- Si UUID existe pero apunta a otro item → RAISE 'IDEMPOTENCY_UUID_REUSE'.
--
-- Las otras RPCs offline (cobrar_venta, anular_venta, descuento, transferir,
-- unir, partir) NO tienen dedup propio en la RPC offline — delegan al
-- idempotency_key de la inner RPC. No afectadas por este bug.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_dedup_item_id BIGINT;
  v_override_id BIGINT;
BEGIN
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);

  -- CRIT-9 FIX: dedup con coherencia de args.
  -- Si el UUID ya existe, debe apuntar al MISMO item — si apunta a otro
  -- (reuse malicioso o bug del cliente), abortar con error explícito.
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id, venta_item_id INTO v_dedup_id, v_dedup_item_id
      FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN
      IF v_dedup_item_id IS DISTINCT FROM v_item_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_UUID_REUSE: UUID % ya consumido para item %, intentando item %',
          p_idempotency_uuid, v_dedup_item_id, v_item_id;
      END IF;
      RETURN; -- retry legítimo
    END IF;
  END IF;

  PERFORM fn_anular_item(v_item_id, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
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
  v_dedup_item_id BIGINT;
  v_override_id BIGINT;
BEGIN
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);

  -- CRIT-9 FIX
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id, venta_item_id INTO v_dedup_id, v_dedup_item_id
      FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN
      IF v_dedup_item_id IS DISTINCT FROM v_item_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_UUID_REUSE: UUID % ya consumido para item %, intentando item %',
          p_idempotency_uuid, v_dedup_item_id, v_item_id;
      END IF;
      RETURN;
    END IF;
  END IF;

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
  v_dedup_item_id BIGINT;
  v_override_id BIGINT;
BEGIN
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);

  -- CRIT-9 FIX
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id, venta_item_id INTO v_dedup_id, v_dedup_item_id
      FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN
      IF v_dedup_item_id IS DISTINCT FROM v_item_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_UUID_REUSE: UUID % ya consumido para item %, intentando item %',
          p_idempotency_uuid, v_dedup_item_id, v_item_id;
      END IF;
      RETURN;
    END IF;
  END IF;

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

NOTIFY pgrst, 'reload schema';
