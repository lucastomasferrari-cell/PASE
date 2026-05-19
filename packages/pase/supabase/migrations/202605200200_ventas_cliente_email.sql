-- ═══════════════════════════════════════════════════════════════════════════
-- Fase B — columna cliente_email en ventas_pos
--
-- Hoy el email del cliente se guarda dentro del campo `notas` con prefix
-- "email: ". Para wirear el flow "Tu pedido está listo" automático desde
-- el POS necesitamos leerlo sin parsear texto.
--
-- Cambios:
--   1. ADD COLUMN cliente_email TEXT
--   2. Backfill: extraer email del notas con regex para pedidos existentes
--   3. CREATE OR REPLACE fn_crear_pedido_publico_comanda — guarda también
--      en la columna nueva (sigue dejando en notas para visibilidad humana
--      del POS sin tener que hacer query extra)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS cliente_email TEXT NULL;

COMMENT ON COLUMN ventas_pos.cliente_email IS
  'Email del cliente que hizo el pedido (tienda online). Usado para mandar notificaciones automáticas. Antes vivía dentro de notas con prefix "email:".';

-- Backfill: extraer email del notas con regex. Acepta el patrón
-- "email: foo@bar.com" + EOL/comma/space.
UPDATE ventas_pos
   SET cliente_email = SUBSTRING(notas FROM 'email:\s*([^\s,\n]+)')
 WHERE cliente_email IS NULL
   AND notas IS NOT NULL
   AND notas ~* 'email:\s*\S+@\S+';

-- Recrear RPC para popular la columna nueva (a partir de ahora).
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
    cliente_nombre, cliente_telefono, cliente_email, cliente_direccion,
    estado, origen, tipo_entrega, notas, pedido_publico_idempotency_key
  ) VALUES (
    v_tenant_id, v_local_id, v_numero, 'pedidos', v_canal_id,
    p_cliente_nombre, p_cliente_telefono, p_cliente_email, p_cliente_direccion,
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
      precio_unitario, modificadores, notas, cargado_por
    ) VALUES (
      v_tenant_id, v_local_id, v_venta_id, (v_item->>'item_id')::INTEGER, v_qty,
      v_pre + v_extras,
      CASE WHEN v_item ? 'modificadores' THEN v_item->'modificadores' ELSE NULL END,
      v_item->>'notas',
      NULL
    );
  END LOOP;

  RETURN QUERY SELECT v_venta_id, v_numero;
END;
$$;

NOTIFY pgrst, 'reload schema';
