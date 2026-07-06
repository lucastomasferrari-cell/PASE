-- 202607060100 · Pedidos flow v2
--
-- Sesión con Lucas 2026-07-05/06. Rediseño del flujo de pedidos:
--   • Al crear un pedido se puede definir el método de pago (opcional).
--   • Al finalizar (Entregar), la venta salta directo a 'entregada'
--     desde cualquier estado activo (abierta / enviada / lista / en_camino).
--   • Al apretar "Listo" en la pantalla de carga, se marcha automáticamente
--     todo lo que quedó en 'hold' por si el cajero se olvidó.
--
-- Todo aditivo — mantiene las RPCs viejas por compatibilidad con VentaScreen
-- de mesa. Las nuevas están específicamente pensadas para el flujo Pedidos.

-- ─── 1. Método de pago previsto en la venta ────────────────────────────────
-- Hint que cargó el cajero al abrir el pedido ("efectivo", "mp_qr", etc).
-- Se usa como default en PaymentDialog y para mostrar "Entregar" (con cobro
-- automático) vs "Cobrar y entregar" en el botón principal del detalle.
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS metodo_pago_previsto text NULL;

COMMENT ON COLUMN ventas_pos.metodo_pago_previsto IS
  'Hint del método de pago cargado en NuevoPedidoDialog. NULL = definir al cobrar.';

-- ─── 2. Marchar TODOS los cursos con items en hold ─────────────────────────
-- Se llama al apretar "Marchar" o "Listo" en la pantalla de carga del pedido.
-- Idempotente: si no hay items en hold, no hace nada. Respeta stay_until_release.
-- Actualiza estado de venta a 'enviada' si estaba en 'abierta' Y quedó al menos
-- un item marchado.
CREATE OR REPLACE FUNCTION fn_pedido_marchar_todo_comanda(p_venta_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id integer;
  v_estado_actual text;
  v_marchados integer;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, estado INTO v_local_id, v_estado_actual
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos_items SET
    estado = 'enviado', enviado_at = NOW(), updated_at = NOW()
   WHERE venta_id = p_venta_id
     AND estado = 'hold'
     AND stay_until_release = FALSE
     AND deleted_at IS NULL;
  GET DIAGNOSTICS v_marchados = ROW_COUNT;

  IF v_marchados > 0 AND v_estado_actual = 'abierta' THEN
    UPDATE ventas_pos SET
      estado = 'enviada', enviada_at = COALESCE(enviada_at, NOW()), updated_at = NOW()
     WHERE id = p_venta_id;
  END IF;

  RETURN v_marchados;
END;
$$;

-- ─── 3. Finalizar pedido — salto directo a 'entregada' ─────────────────────
-- Se llama al apretar "Entregar" o "Cobrar y entregar" en el detalle.
-- Avanza la venta desde cualquier estado activo hasta 'entregada' en un shot.
-- Los items en 'hold' pasan directo a 'entregado' (skippeando cocina — el
-- cajero está diciendo "ya lo entregué, no hace falta cocinar").
-- No cobra — el cobro va aparte por fn_cobrar_venta_comanda.
CREATE OR REPLACE FUNCTION fn_pedido_finalizar_comanda(p_venta_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id integer;
  v_estado_actual text;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, estado INTO v_local_id, v_estado_actual
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado_actual IN ('cobrada', 'entregada', 'anulada') THEN
    -- Ya está cerrada o entregada; nada que hacer.
    RETURN;
  END IF;

  IF v_estado_actual NOT IN ('abierta', 'enviada', 'lista', 'en_camino', 'necesita_aprobacion') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO_PARA_ENTREGAR' USING HINT = v_estado_actual;
  END IF;

  UPDATE ventas_pos_items SET
    estado = 'entregado', updated_at = NOW()
   WHERE venta_id = p_venta_id
     AND estado IN ('hold', 'enviado', 'listo')
     AND deleted_at IS NULL;

  UPDATE ventas_pos SET
    estado = 'entregada',
    enviada_at = COALESCE(enviada_at, NOW()),
    listo_at = COALESCE(listo_at, NOW()),
    entregada_at = COALESCE(entregada_at, NOW()),
    updated_at = NOW()
   WHERE id = p_venta_id;
END;
$$;

-- ─── 4. Wire p_metodo_pago_previsto en fn_abrir_venta_comanda ──────────────
CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda(
  p_local_id integer,
  p_modo text,
  p_canal_id integer,
  p_mesa_id bigint DEFAULT NULL,
  p_mozo_id uuid DEFAULT NULL,
  p_cajero_id uuid DEFAULT NULL,
  p_cliente_nombre text DEFAULT NULL,
  p_cliente_telefono text DEFAULT NULL,
  p_cliente_direccion text DEFAULT NULL,
  p_covers integer DEFAULT NULL,
  p_origen text DEFAULT 'pos',
  p_tipo_entrega text DEFAULT NULL,
  p_estado text DEFAULT 'abierta',
  p_programada_para timestamptz DEFAULT NULL,
  p_cliente_id bigint DEFAULT NULL,
  p_metodo_pago_previsto text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id BIGINT;
  v_numero INTEGER;
  v_turno_id BIGINT;
  v_reserva_cliente BIGINT;
BEGIN
  IF p_origen = 'pos' AND NOT (
    fn_check_perm_comanda('comanda.ventas.abrir') OR
    fn_check_perm_comanda('comanda.ventas.cobrar')
  ) THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  IF v_turno_id IS NULL AND p_origen = 'pos' AND p_modo != 'pedidos' THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;

  v_numero := fn_next_ticket_number_comanda(p_local_id);

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id, turno_caja_id,
    mesa_id, mozo_id, cajero_id, cliente_id, cliente_nombre, cliente_telefono,
    cliente_direccion, covers, origen, tipo_entrega, estado, programada_para,
    metodo_pago_previsto
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_modo, p_canal_id, v_turno_id,
    p_mesa_id, p_mozo_id, p_cajero_id, p_cliente_id, p_cliente_nombre, p_cliente_telefono,
    p_cliente_direccion, p_covers, p_origen, p_tipo_entrega, p_estado, p_programada_para,
    p_metodo_pago_previsto
  ) RETURNING id INTO v_id;

  IF p_mesa_id IS NOT NULL AND p_estado = 'abierta' THEN
    UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_id AND estado = 'libre';
  END IF;

  IF p_mesa_id IS NOT NULL THEN
    UPDATE reservas r
       SET venta_id = v_id, updated_at = NOW()
     WHERE r.id = (
       SELECT r2.id FROM reservas r2
        WHERE r2.mesa_id = p_mesa_id
          AND r2.local_id = p_local_id
          AND r2.estado = 'sentada'
          AND r2.venta_id IS NULL
          AND r2.deleted_at IS NULL
          AND r2.fecha_hora BETWEEN NOW() - INTERVAL '4 hours' AND NOW() + INTERVAL '2 hours'
        ORDER BY abs(extract(epoch FROM (r2.fecha_hora - NOW()))) ASC
        LIMIT 1
     )
     RETURNING r.cliente_id INTO v_reserva_cliente;
    IF v_reserva_cliente IS NOT NULL THEN
      UPDATE ventas_pos SET cliente_id = COALESCE(cliente_id, v_reserva_cliente)
       WHERE id = v_id;
    END IF;
  END IF;

  PERFORM fn_ensure_cubierto_en_venta(v_id);

  RETURN v_id;
END;
$$;

-- ─── 5. Wire p_metodo_pago_previsto en fn_abrir_venta_comanda_offline ──────
CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda_offline(
  p_local_id integer,
  p_canal_id integer,
  p_modo text,
  p_mesa_id integer DEFAULT NULL,
  p_mozo_id uuid DEFAULT NULL,
  p_cajero_id uuid DEFAULT NULL,
  p_cliente_id integer DEFAULT NULL,
  p_covers integer DEFAULT NULL,
  p_tab_nombre text DEFAULT NULL,
  p_idempotency_uuid uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metodo_pago_previsto text DEFAULT NULL
) RETURNS bigint
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
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM ventas_pos WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  IF auth_tenant_id() IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  PERFORM fn_assert_local_autorizado(p_local_id);

  SELECT COALESCE(MAX(numero_local), 0) + 1
    INTO v_numero_local
    FROM ventas_pos
   WHERE local_id = p_local_id;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, canal_id, modo, mesa_id,
    mozo_id, cajero_id, cliente_id, covers, tab_nombre,
    turno_caja_id, estado, abierta_at, idempotency_uuid, metodo_pago_previsto
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero_local, p_canal_id, p_modo, p_mesa_id,
    p_mozo_id, p_cajero_id, p_cliente_id, p_covers, p_tab_nombre,
    v_turno_id, 'abierta', NOW(), p_idempotency_uuid, p_metodo_pago_previsto
  )
  RETURNING id INTO v_new_id;

  PERFORM fn_ensure_cubierto_en_venta(v_new_id);

  RETURN v_new_id;
END;
$$;
