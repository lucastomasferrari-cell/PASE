-- 202607060200 · Auto-marchar items en pedidos
--
-- Lucas 2026-07-06: "no podés crear un pedido y que no se marche en cocina,
-- eso debería ser automático". En modo 'pedidos', cada item que se agrega
-- se manda directo a cocina — sin estado intermedio 'hold'.
--
-- Solo aplica a modo='pedidos'. Mesa/mostrador siguen igual (el mesero
-- decide cuándo marchar cada curso).

-- ─── Online: fn_agregar_item_comanda ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_agregar_item_comanda(
  p_venta_id bigint,
  p_item_id integer,
  p_cantidad numeric,
  p_curso integer DEFAULT 1,
  p_modificadores jsonb DEFAULT NULL,
  p_notas text DEFAULT NULL,
  p_cargado_por uuid DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id BIGINT;
  v_local_id INTEGER;
  v_canal_id INTEGER;
  v_estado TEXT;
  v_modo TEXT;
  v_precio NUMERIC;
  v_extras NUMERIC := 0;
  v_subtotal NUMERIC;
  v_mod JSONB;
  v_es_pedido BOOLEAN;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, canal_id, estado, modo INTO v_local_id, v_canal_id, v_estado, v_modo
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_estado IN ('cobrada','anulada') THEN
    RAISE EXCEPTION 'VENTA_NO_EDITABLE: estado %', v_estado;
  END IF;

  v_es_pedido := (v_modo = 'pedidos');

  -- Tomar precio del canal de la venta; fallback a precio_madre
  SELECT precio INTO v_precio
    FROM item_precios_canal
   WHERE item_id = p_item_id AND canal_id = v_canal_id AND deleted_at IS NULL
   LIMIT 1;
  IF v_precio IS NULL THEN
    SELECT precio_madre INTO v_precio FROM items WHERE id = p_item_id;
  END IF;
  IF v_precio IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  IF p_modificadores IS NOT NULL THEN
    FOR v_mod IN SELECT * FROM jsonb_array_elements(p_modificadores) LOOP
      v_extras := v_extras + COALESCE((v_mod->>'precio_extra')::NUMERIC, 0);
    END LOOP;
  END IF;

  v_subtotal := (v_precio + v_extras) * p_cantidad;

  -- Auto-marchar si es pedido: estado='enviado' + enviado_at. Mesa/mostrador → 'hold' (default).
  INSERT INTO ventas_pos_items (
    tenant_id, local_id, venta_id, item_id, cantidad, precio_unitario,
    subtotal, modificadores, curso, notas, cargado_por,
    estado, enviado_at
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, p_item_id, p_cantidad,
    v_precio + v_extras, v_subtotal, p_modificadores, p_curso, p_notas, p_cargado_por,
    CASE WHEN v_es_pedido THEN 'enviado' ELSE 'hold' END,
    CASE WHEN v_es_pedido THEN NOW() ELSE NULL END
  ) RETURNING id INTO v_id;

  -- Si es pedido y venta estaba abierta → pasar a 'enviada'.
  IF v_es_pedido AND v_estado = 'abierta' THEN
    UPDATE ventas_pos
       SET estado = 'enviada', enviada_at = COALESCE(enviada_at, NOW()), updated_at = NOW()
     WHERE id = p_venta_id;
  END IF;

  PERFORM fn_recalc_total_venta(p_venta_id);
  RETURN v_id;
END;
$$;

-- ─── Offline: fn_agregar_item_comanda_offline ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_agregar_item_comanda_offline(
  p_venta_id bigint,
  p_venta_idempotency_uuid uuid,
  p_item_id integer,
  p_cantidad numeric,
  p_precio_unitario numeric,
  p_curso integer DEFAULT 1,
  p_modificadores jsonb DEFAULT NULL,
  p_notas text DEFAULT NULL,
  p_cargado_por uuid DEFAULT NULL,
  p_idempotency_uuid uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS bigint
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
  v_estado TEXT;
  v_modo TEXT;
  v_es_pedido BOOLEAN;
BEGIN
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM ventas_pos_items WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;
  END IF;

  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  SELECT local_id, tenant_id, estado, modo INTO v_local_id, v_tenant, v_estado, v_modo
    FROM ventas_pos WHERE id = v_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  v_es_pedido := (v_modo = 'pedidos');

  INSERT INTO ventas_pos_items (
    tenant_id, local_id, venta_id, item_id, cantidad, precio_unitario, subtotal,
    curso, modificadores, notas, cargado_por,
    estado, enviado_at,
    idempotency_uuid, venta_idempotency_uuid
  ) VALUES (
    v_tenant, v_local_id, v_venta_id, p_item_id, p_cantidad, p_precio_unitario,
    p_cantidad * p_precio_unitario, p_curso, p_modificadores, p_notas, p_cargado_por,
    CASE WHEN v_es_pedido THEN 'enviado' ELSE 'hold' END,
    CASE WHEN v_es_pedido THEN NOW() ELSE NULL END,
    p_idempotency_uuid, p_venta_idempotency_uuid
  ) RETURNING id INTO v_new_id;

  IF v_es_pedido AND v_estado = 'abierta' THEN
    UPDATE ventas_pos
       SET estado = 'enviada', enviada_at = COALESCE(enviada_at, NOW()), updated_at = NOW()
     WHERE id = v_venta_id;
  END IF;

  PERFORM fn_recalc_total_venta(v_venta_id);
  RETURN v_new_id;
END;
$$;

-- ─── Backfill: pedidos abiertos con items ya cargados → pasarlos a enviada ─
-- Los pedidos que quedaron en estado 'abierta' con items en 'hold' antes de
-- este cambio quedan "colgados" en el flujo viejo. Los movemos ahora:
--   - Items en 'hold' → 'enviado' + enviado_at=NOW()
--   - Venta 'abierta' → 'enviada'
UPDATE ventas_pos_items
   SET estado = 'enviado',
       enviado_at = COALESCE(enviado_at, NOW()),
       updated_at = NOW()
 WHERE venta_id IN (
   SELECT id FROM ventas_pos
    WHERE modo = 'pedidos' AND estado = 'abierta' AND deleted_at IS NULL
 )
   AND estado = 'hold'
   AND stay_until_release = FALSE
   AND deleted_at IS NULL;

UPDATE ventas_pos
   SET estado = 'enviada',
       enviada_at = COALESCE(enviada_at, NOW()),
       updated_at = NOW()
 WHERE modo = 'pedidos'
   AND estado = 'abierta'
   AND deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM ventas_pos_items i
      WHERE i.venta_id = ventas_pos.id AND i.deleted_at IS NULL
   );
