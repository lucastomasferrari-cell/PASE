-- ═══════════════════════════════════════════════════════════════════════════
-- F1.6 — Idempotency en fn_cerrar_turno_caja_comanda + fn_crear_pedido_publico_comanda
--
-- Detectado en auditoría estructural 2026-05-15: estas 2 RPCs movían plata
-- pero NO tenían p_idempotency_key. Doble click en "cerrar caja" o doble tap
-- en "confirmar pedido" generaba duplicados (movimientos_caja de cierre, o
-- pedido público duplicado).
--
-- Patrón: igual que sprint 7 — columna `*_idempotency_key TEXT NULL` +
-- UNIQUE INDEX parcial. Si la RPC se llama 2x con misma key, devuelve el
-- resultado del primer call sin re-ejecutar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Columnas de idempotency ────────────────────────────────────────────
ALTER TABLE turnos_caja
  ADD COLUMN IF NOT EXISTS cerrar_idempotency_key TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_caja_cerrar_idempotency
  ON turnos_caja(cerrar_idempotency_key) WHERE cerrar_idempotency_key IS NOT NULL;

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS pedido_publico_idempotency_key TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_pos_pedido_publico_idempotency
  ON ventas_pos(pedido_publico_idempotency_key) WHERE pedido_publico_idempotency_key IS NOT NULL;

-- ─── 2. fn_cerrar_turno_caja_comanda con idempotency ──────────────────────
DROP FUNCTION IF EXISTS fn_cerrar_turno_caja_comanda(BIGINT, UUID, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION fn_cerrar_turno_caja_comanda(
  p_turno_id BIGINT,
  p_cerrado_por UUID,
  p_monto_final_declarado NUMERIC,
  p_notas TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE(
  monto_calculado NUMERIC,
  diferencia NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calculado NUMERIC;
  v_local_id INTEGER;
  v_estado_actual TEXT;
  v_existing_monto_calc NUMERIC;
  v_existing_monto_decl NUMERIC;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.cerrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_CERRAR';
  END IF;

  -- F1.6 idempotency: si la key ya fue usada para este turno, devolver el
  -- resultado existente sin re-cerrar.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT monto_final_calculado, monto_final_declarado, estado
      INTO v_existing_monto_calc, v_existing_monto_decl, v_estado_actual
      FROM turnos_caja
     WHERE id = p_turno_id AND cerrar_idempotency_key = p_idempotency_key;
    IF v_existing_monto_calc IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_monto_calc, v_existing_monto_decl - v_existing_monto_calc;
      RETURN;
    END IF;
  END IF;

  SELECT local_id, estado INTO v_local_id, v_estado_actual
    FROM turnos_caja WHERE id = p_turno_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'TURNO_NO_ENCONTRADO'; END IF;
  IF v_estado_actual = 'cerrado' THEN RAISE EXCEPTION 'TURNO_YA_CERRADO'; END IF;

  -- F1.5: assert local autorizado.
  PERFORM fn_assert_local_autorizado(v_local_id);

  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('apertura','venta','deposito','ajuste') THEN monto
      WHEN tipo IN ('retiro','venta_anulada') THEN -monto
      ELSE 0
    END
  ), 0) INTO v_calculado
    FROM movimientos_caja
   WHERE turno_caja_id = p_turno_id AND metodo = 'efectivo';

  UPDATE turnos_caja SET
    estado = 'cerrado',
    cerrado_at = NOW(),
    cerrado_por = p_cerrado_por,
    monto_final_declarado = p_monto_final_declarado,
    monto_final_calculado = v_calculado,
    diferencia = p_monto_final_declarado - v_calculado,
    notas = COALESCE(notas, '') || COALESCE(E'\n--cierre--\n' || p_notas, ''),
    cerrar_idempotency_key = p_idempotency_key
  WHERE id = p_turno_id;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_turno_id, p_cerrado_por, 'cierre',
    p_monto_final_declarado, 'efectivo', 'Cierre de turno (declarado)',
    -- Sub-key derivado para el movimiento_caja: hereda idempotency del cierre.
    CASE WHEN p_idempotency_key IS NOT NULL
         THEN 'cierre_turno_' || p_idempotency_key
         ELSE NULL
    END
  );

  RETURN QUERY SELECT v_calculado, p_monto_final_declarado - v_calculado;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cerrar_turno_caja_comanda(BIGINT, UUID, NUMERIC, TEXT, TEXT) TO authenticated;

-- ─── 3. fn_crear_pedido_publico_comanda con idempotency ──────────────────
DROP FUNCTION IF EXISTS fn_crear_pedido_publico_comanda(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT);

CREATE OR REPLACE FUNCTION fn_crear_pedido_publico_comanda(
  p_local_slug TEXT,
  p_cliente_nombre TEXT,
  p_cliente_telefono TEXT,
  p_cliente_email TEXT,
  p_tipo_entrega TEXT,
  p_cliente_direccion TEXT,
  p_items JSONB,
  p_metodo_pago_preferido TEXT,
  p_notas TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE (venta_id BIGINT, numero_local INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
  v_tenant_id UUID;
  v_canal_id INTEGER;
  v_venta_id BIGINT;
  v_numero INTEGER;
  v_item JSONB;
  v_pre NUMERIC;
  v_extras NUMERIC;
  v_qty NUMERIC;
  v_mod JSONB;
  v_acepta_delivery BOOLEAN;
  v_existing_id BIGINT;
  v_existing_num INTEGER;
BEGIN
  -- F1.6 idempotency: si la key ya fue usada, devolver el pedido existente.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, ventas_pos.numero_local INTO v_existing_id, v_existing_num
      FROM ventas_pos
     WHERE pedido_publico_idempotency_key = p_idempotency_key
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_num;
      RETURN;
    END IF;
  END IF;

  SELECT cls.local_id, cls.tenant_id, cls.acepta_delivery
    INTO v_local_id, v_tenant_id, v_acepta_delivery
    FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  IF p_tipo_entrega = 'delivery' AND NOT v_acepta_delivery THEN
    RAISE EXCEPTION 'LOCAL_NO_ACEPTA_DELIVERY';
  END IF;
  IF p_tipo_entrega NOT IN ('retiro','delivery') THEN
    RAISE EXCEPTION 'TIPO_ENTREGA_INVALIDO';
  END IF;

  SELECT id INTO v_canal_id FROM canales
   WHERE tenant_id = v_tenant_id AND slug = 'tienda-propia'
     AND deleted_at IS NULL AND activo = TRUE
     AND (local_id IS NULL OR local_id = v_local_id)
   ORDER BY local_id NULLS LAST
   LIMIT 1;
  IF v_canal_id IS NULL THEN RAISE EXCEPTION 'CANAL_TIENDA_NO_CONFIGURADO'; END IF;

  SELECT COALESCE(MAX(ventas_pos.numero_local), 0) + 1 INTO v_numero
    FROM ventas_pos WHERE ventas_pos.local_id = v_local_id;

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id,
    cliente_nombre, cliente_telefono, cliente_direccion,
    estado, origen, tipo_entrega, notas, pedido_publico_idempotency_key
  ) VALUES (
    v_tenant_id, v_local_id, v_numero, 'pedidos', v_canal_id,
    p_cliente_nombre, p_cliente_telefono, p_cliente_direccion,
    'necesita_aprobacion', 'tienda_online', p_tipo_entrega,
    COALESCE(p_notas, '') ||
    CASE WHEN p_cliente_email IS NOT NULL THEN E'\nemail: ' || p_cliente_email ELSE '' END ||
    E'\nmetodo_preferido: ' || COALESCE(p_metodo_pago_preferido,'no especificado'),
    p_idempotency_key
  ) RETURNING id INTO v_venta_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'cantidad')::NUMERIC, 1);
    SELECT precio INTO v_pre FROM item_precios_canal
     WHERE item_id = (v_item->>'item_id')::INTEGER AND canal_id = v_canal_id
       AND deleted_at IS NULL LIMIT 1;
    IF v_pre IS NULL THEN
      SELECT precio_madre INTO v_pre FROM items
       WHERE id = (v_item->>'item_id')::INTEGER;
    END IF;
    IF v_pre IS NULL THEN RAISE EXCEPTION 'ITEM_NO_DISPONIBLE'; END IF;

    v_extras := 0;
    IF v_item ? 'modificadores' THEN
      FOR v_mod IN SELECT * FROM jsonb_array_elements(v_item->'modificadores') LOOP
        v_extras := v_extras + COALESCE((v_mod->>'precio_extra')::NUMERIC, 0);
      END LOOP;
    END IF;

    INSERT INTO ventas_pos_items (
      tenant_id, local_id, venta_id, item_id, cantidad,
      precio_unitario, subtotal, modificadores, curso, notas, estado
    ) VALUES (
      v_tenant_id, v_local_id, v_venta_id, (v_item->>'item_id')::INTEGER, v_qty,
      v_pre + v_extras, (v_pre + v_extras) * v_qty,
      v_item->'modificadores', 1, v_item->>'notas', 'hold'
    );
  END LOOP;

  PERFORM fn_recalc_total_venta(v_venta_id);

  RETURN QUERY SELECT v_venta_id, v_numero;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_crear_pedido_publico_comanda(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN F1.6
-- ═══════════════════════════════════════════════════════════════════════════
