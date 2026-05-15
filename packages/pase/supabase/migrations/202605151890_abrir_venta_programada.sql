-- ═══════════════════════════════════════════════════════════════════════════
-- Pedidos programados — fn_abrir_venta_comanda acepta p_programada_para
-- ═══════════════════════════════════════════════════════════════════════════
-- Permite crear pedidos manuales con fecha/hora futura ("para las 21:00").
-- Compatible: arg DEFAULT NULL no rompe callers existentes.

DROP FUNCTION IF EXISTS fn_abrir_venta_comanda(INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda(
  p_local_id INTEGER,
  p_modo TEXT,
  p_canal_id INTEGER,
  p_mesa_id BIGINT DEFAULT NULL,
  p_mozo_id UUID DEFAULT NULL,
  p_cajero_id UUID DEFAULT NULL,
  p_cliente_nombre TEXT DEFAULT NULL,
  p_cliente_telefono TEXT DEFAULT NULL,
  p_cliente_direccion TEXT DEFAULT NULL,
  p_covers INTEGER DEFAULT NULL,
  p_origen TEXT DEFAULT 'pos',
  p_tipo_entrega TEXT DEFAULT NULL,
  p_estado TEXT DEFAULT 'abierta',
  p_programada_para TIMESTAMPTZ DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_id BIGINT;
  v_numero INTEGER;
  v_turno_id BIGINT;
BEGIN
  IF p_origen = 'pos' AND NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
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
    mesa_id, mozo_id, cajero_id, cliente_nombre, cliente_telefono,
    cliente_direccion, covers, origen, tipo_entrega, estado, programada_para
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_modo, p_canal_id, v_turno_id,
    p_mesa_id, p_mozo_id, p_cajero_id, p_cliente_nombre, p_cliente_telefono,
    p_cliente_direccion, p_covers, p_origen, p_tipo_entrega, p_estado, p_programada_para
  ) RETURNING id INTO v_id;

  IF p_mesa_id IS NOT NULL AND p_estado = 'abierta' THEN
    UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_id AND estado = 'libre';
  END IF;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_abrir_venta_comanda(INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
