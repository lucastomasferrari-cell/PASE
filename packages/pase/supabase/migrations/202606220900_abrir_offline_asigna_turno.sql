-- 202606220900_abrir_offline_asigna_turno.sql
-- COMANDA offline rebuild Fase 2 (plata): la venta abierta offline ahora se
-- asocia al TURNO de caja abierto del local, igual que la venta online. Sin esto,
-- la venta offline quedaba con turno_caja_id NULL y al cobrar (fn_agregar_pago_
-- venta_comanda) NO generaba el movimiento de caja → la venta cobrada offline no
-- impactaba la caja/arqueo.
--
-- Diferencia con la online: la online hace RAISE 'NO_HAY_TURNO_ABIERTO' si no hay
-- turno. OFFLINE NO puede hacer RAISE acá: la venta ya se creó en la tablet y esta
-- RPC corre al SINCRONIZAR; bloquear el sync dejaría la venta colgada para siempre.
-- Si al sincronizar no hay turno abierto, queda NULL (esa venta no impacta caja,
-- igual que hasta ahora) — caso de borde; lo normal es sincronizar dentro del turno.
--
-- CREATE OR REPLACE idéntico a 202606021200 + (a) declara v_turno_id, (b) lo
-- resuelve del turno abierto, (c) lo agrega al INSERT. Resto sin cambios.
-- REVOKE FROM PUBLIC + GRANT authenticated (lección 11-jun). Aditivo.
BEGIN;

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
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id BIGINT;
  v_new_id BIGINT;
  v_numero_local INTEGER;
  v_turno_id BIGINT;
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

  -- numero_local correlativo por local (fix 2026-06-02)
  SELECT COALESCE(MAX(numero_local), 0) + 1
    INTO v_numero_local
    FROM ventas_pos
   WHERE local_id = p_local_id;

  -- Fase 2 (2026-06-22): turno de caja ABIERTO del local (igual que online).
  -- OFFLINE: sin RAISE si no hay turno → queda NULL, no bloquea el sync.
  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  -- Insert nueva venta
  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, canal_id, modo, mesa_id,
    mozo_id, cajero_id, cliente_id, covers, tab_nombre,
    turno_caja_id, estado, abierta_at, idempotency_uuid
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero_local, p_canal_id, p_modo, p_mesa_id,
    p_mozo_id, p_cajero_id, p_cliente_id, p_covers, p_tab_nombre,
    v_turno_id, 'abierta', NOW(), p_idempotency_uuid
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

COMMIT;
