-- 202606021200_fix_abrir_venta_offline_numero_local.sql
-- Brainstorm #8 / Sprint A2 — Fix bug crítico offline-first (2026-06-02).
--
-- Bug Anto/Lucas: tocar "Nueva orden" funcionaba localmente (idb) pero el
-- sync al server fallaba con:
--   POST /rpc/fn_abrir_venta_comanda_offline → 400 Bad Request
-- Resultado: la venta queda con id temp negativo permanente, nunca se
-- reconcilia, y al cobrarla más tarde rompe.
--
-- Causa raíz: la RPC fn_abrir_venta_comanda_offline (migration 202605161400)
-- hace INSERT INTO ventas_pos sin calcular numero_local. El comment decía
-- "lo asigna trigger autoincrement" pero ese trigger NUNCA EXISTIÓ. Todas
-- las otras RPCs (fn_abrir_venta_comanda, fn_aprobar_pedido_comanda,
-- fn_crear_pedido_publico_comanda) hacen el calc manual:
--   SELECT COALESCE(MAX(numero_local), 0) + 1 INTO v_next
--     FROM ventas_pos WHERE local_id = ...
-- Replicamos el mismo patrón acá.
--
-- Fix idempotente: CREATE OR REPLACE — no rompe instalación existente,
-- no requiere DROP (la signature no cambia).

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
  v_numero_local INTEGER;
BEGIN
  -- Dedup natural por idempotency_uuid (no recrear si ya existe)
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

  -- FIX 2026-06-02: calcular numero_local correlativo por local.
  -- Mismo patrón que fn_abrir_venta_comanda + fn_aprobar_pedido_comanda
  -- (sprint 2 — 202605051800). Antes este INSERT fallaba con NOT NULL
  -- violation porque numero_local quedaba NULL.
  SELECT COALESCE(MAX(numero_local), 0) + 1
    INTO v_numero_local
    FROM ventas_pos
   WHERE local_id = p_local_id;

  -- Insert nueva venta
  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, canal_id, modo, mesa_id,
    mozo_id, cajero_id, cliente_id, covers, tab_nombre,
    estado, abierta_at, idempotency_uuid
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero_local, p_canal_id, p_modo, p_mesa_id,
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

NOTIFY pgrst, 'reload schema';
