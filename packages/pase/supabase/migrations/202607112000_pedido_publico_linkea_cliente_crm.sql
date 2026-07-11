-- ═══════════════════════════════════════════════════════════════════════════
-- Tienda online: enganchar al comprador al CRM (clientes) + fidelidad.
--
-- fn_crear_pedido_publico_comanda guardaba cliente_nombre/telefono/direccion
-- como texto suelto en ventas_pos, pero NO creaba ni linkeaba la ficha en
-- `clientes` (a diferencia de las reservas de MESA). Resultado: los compradores
-- del marketplace no entraban al CRM (Habitué) ni sumaban puntos/contadores
-- (el trigger fn_trg_actualizar_cliente_counters solo actúa si cliente_id != NULL).
--
-- Fix: la función ahora hace upsert del cliente por teléfono (MISMO helper que
-- usan las reservas, fn_upsert_cliente_publico_comanda) y setea
-- ventas_pos.cliente_id. Best-effort: si el CRM falla, el pedido igual se crea
-- (no se rompe la venta por el CRM). Misma firma y grants (CREATE OR REPLACE
-- los preserva). SECURITY DEFINER → la llamada anidada al upsert corre con
-- privilegios del owner (no depende de los grants de anon).
-- ═══════════════════════════════════════════════════════════════════════════

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
  p_programada_para TIMESTAMPTZ DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE (venta_id BIGINT, numero_local INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
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
  v_now TIMESTAMPTZ := now();
  v_cached_result jsonb;
  v_cliente_id BIGINT;
BEGIN
  -- Idempotency: si llega misma key, devolver resultado cacheado.
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached_result FROM idempotency_keys
     WHERE rpc_name = 'fn_crear_pedido_publico_comanda' AND key = p_idempotency_key;
    IF v_cached_result IS NOT NULL THEN
      RETURN QUERY SELECT
        (v_cached_result->>'venta_id')::BIGINT,
        (v_cached_result->>'numero_local')::INTEGER;
      RETURN;
    END IF;
  END IF;

  -- Resolver local
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

  -- Programación: validar fecha futura razonable (15min a 14 días).
  IF p_programada_para IS NOT NULL THEN
    IF p_programada_para < v_now + INTERVAL '15 minutes' THEN
      RAISE EXCEPTION 'PROGRAMACION_DEMASIADO_PRONTO';
    END IF;
    IF p_programada_para > v_now + INTERVAL '14 days' THEN
      RAISE EXCEPTION 'PROGRAMACION_DEMASIADO_LEJOS';
    END IF;
  END IF;

  SELECT id INTO v_canal_id FROM canales
   WHERE tenant_id = v_tenant_id AND slug = 'tienda-propia'
     AND deleted_at IS NULL AND activo = TRUE
     AND (local_id IS NULL OR local_id = v_local_id)
   ORDER BY local_id NULLS LAST
   LIMIT 1;
  IF v_canal_id IS NULL THEN RAISE EXCEPTION 'CANAL_TIENDA_NO_CONFIGURADO'; END IF;

  -- CRM: crear/enganchar la ficha del cliente por teléfono (mismo helper que las
  -- reservas de MESA) para que el comprador online entre a Habitué + fidelidad +
  -- los contadores de consumo. Best-effort: si falla, el pedido igual se crea.
  IF p_cliente_telefono IS NOT NULL AND length(trim(p_cliente_telefono)) > 0 THEN
    BEGIN
      v_cliente_id := fn_upsert_cliente_publico_comanda(
        p_local_slug, p_cliente_telefono, p_cliente_nombre,
        p_cliente_email, p_cliente_direccion, NULL
      );
    EXCEPTION WHEN OTHERS THEN
      v_cliente_id := NULL; -- best-effort: no romper la venta por el CRM
    END;
  END IF;

  SELECT COALESCE(MAX(numero_local), 0) + 1 INTO v_numero
    FROM ventas_pos WHERE local_id = v_local_id;

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id,
    cliente_id, cliente_nombre, cliente_telefono, cliente_direccion,
    estado, origen, tipo_entrega, notas, programada_para
  ) VALUES (
    v_tenant_id, v_local_id, v_numero, 'pedidos', v_canal_id,
    v_cliente_id, p_cliente_nombre, p_cliente_telefono, p_cliente_direccion,
    'necesita_aprobacion', 'tienda_online', p_tipo_entrega,
    COALESCE(p_notas, '') ||
    CASE WHEN p_cliente_email IS NOT NULL THEN E'\nemail: ' || p_cliente_email ELSE '' END ||
    E'\nmetodo_preferido: ' || COALESCE(p_metodo_pago_preferido,'no especificado'),
    p_programada_para
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

  -- Cachear resultado de idempotency
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('fn_crear_pedido_publico_comanda', p_idempotency_key, v_tenant_id,
      jsonb_build_object('venta_id', v_venta_id, 'numero_local', v_numero))
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero;
END;
$$;

NOTIFY pgrst, 'reload schema';
