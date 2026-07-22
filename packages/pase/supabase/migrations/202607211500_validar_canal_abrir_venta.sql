-- ════════════════════════════════════════════════════════════════════════════
-- Blindaje: validar canal_id al abrir una venta (COMANDA)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Contexto del bug (2026-07-21):
--   El canal_id de la venta lo elige el frontend (SalonView / MostradorView /
--   NuevoPedidoDialog) buscando el canal por slug/modo_pos en `canales`, y el
--   RPC lo insertaba TAL CUAL sin validar. Cuando la venta la abre un usuario
--   SUPERADMIN, la RLS de `canales` devuelve canales de TODOS los tenants, así
--   que el `.find(...)` del cliente podía agarrar un canal AJENO o incoherente.
--   Resultado real en Neko: ventas modo='salon' con canal de Mostrador o con
--   canal inexistente/de otro tenant (id 313/315), lo que rompe el precio del
--   ítem (fn_agregar_item_comanda lee item_precios_canal por venta.canal_id) y,
--   desde el fix del 21-jul, también el menú que muestra el POS.
--
-- Defensa (server-authoritative): antes de insertar, el canal DEBE
--   - existir y no estar borrado,
--   - pertenecer al MISMO tenant que la venta (auth_tenant_id()) — esto corta
--     el leak cross-tenant aunque el cliente mande basura, porque el RPC es
--     SECURITY DEFINER y filtra por tenant sin depender de la RLS,
--   - aplicar al local (global local_id IS NULL, o el mismo p_local_id),
--   - tener modo_pos coherente con el modo de la venta
--     (ventas_pos.modo y canales.modo_pos comparten el dominio
--      'salon' | 'mostrador' | 'pedidos'; Menú QR es modo_pos='salon', válido).
--   Si no cumple → RAISE 'CANAL_INVALIDO' (mapeado en src/lib/errors.ts).
--
-- Reemplaza las definiciones vigentes en 202607060100_pedidos_flow_v2.sql
-- (online) y su variante _offline, sin otros cambios de comportamiento.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── limpieza: overload viejo sin guard ─────────────────────────────────────
-- Al agregar params (p_metodo_pago_previsto en 202607060100) con CREATE OR
-- REPLACE se creó un NUEVO overload y el anterior de 15 params quedó colgado
-- SIN el guard (y generando ambigüedad PGRST203 en llamadas que omiten el
-- último param). El frontend siempre manda los 16, así que ese overload no
-- tiene caller vivo en prod (el único uso de 15 params es test-only). Lo
-- dropeamos para que exista UNA sola definición, con el guard.
DROP FUNCTION IF EXISTS public.fn_abrir_venta_comanda(
  integer, text, integer, bigint, uuid, uuid, text, text, text, integer,
  text, text, text, timestamptz, bigint
);

-- ─── online ────────────────────────────────────────────────────────────────
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

  -- Validación de canal (defensa server-authoritative). Ver cabecera.
  IF p_canal_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM canales c
     WHERE c.id = p_canal_id
       AND c.deleted_at IS NULL
       AND c.tenant_id = auth_tenant_id()
       AND (c.local_id IS NULL OR c.local_id = p_local_id)
       AND c.modo_pos = p_modo
  ) THEN
    RAISE EXCEPTION 'CANAL_INVALIDO';
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

-- ─── offline (encolado desde el sync engine) ───────────────────────────────
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

  -- Validación de canal (defensa server-authoritative). Ver cabecera.
  IF p_canal_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM canales c
     WHERE c.id = p_canal_id
       AND c.deleted_at IS NULL
       AND c.tenant_id = auth_tenant_id()
       AND (c.local_id IS NULL OR c.local_id = p_local_id)
       AND c.modo_pos = p_modo
  ) THEN
    RAISE EXCEPTION 'CANAL_INVALIDO';
  END IF;

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
