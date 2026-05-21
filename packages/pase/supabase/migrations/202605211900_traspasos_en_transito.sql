-- ═══════════════════════════════════════════════════════════════════════════
-- Flujo "En Tránsito" para transferencias entre locales
--
-- Visión PASE original: "El stock no sube en el Local B hasta que el
-- encargado de ahí le da 'Aceptar Recepción'. Mientras tanto, esa
-- mercadería está en estado 'En Tránsito'".
--
-- Modelo anterior (fn_transferir_stock_local): atómico. Movimiento de
-- salida en origen + movimiento de entrada en destino se hacen en la
-- misma RPC. No hay estado intermedio — si el origen carga mal y nadie
-- en destino recibe, el sistema queda inconsistente sin auditoria.
--
-- Modelo nuevo (este archivo):
--   1. Origen llama fn_iniciar_traspaso → stock baja en origen, fila en
--      stock_transferencias con estado='en_transito'. NO sube en destino.
--   2. Destino llama fn_confirmar_recepcion → estado='confirmada', se
--      genera el movimiento de entrada en destino.
--   3. Destino llama fn_rechazar_recepcion → estado='rechazada', se
--      devuelve el stock al origen (con motivo).
--   4. Origen llama fn_cancelar_traspaso → estado='cancelada', se
--      devuelve el stock al origen (sin motivo de rechazo).
--
-- Auditoría: cada movimiento tiene fuente_tipo='transferencia' +
-- fuente_id=stock_transferencias.id para trazabilidad.
--
-- fn_transferir_stock_local (la atómica anterior) queda para compat —
-- pero el front la deja de usar y usa las nuevas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Columnas de estado ────────────────────────────────────────────────
ALTER TABLE stock_transferencias
  ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'confirmada'
    CHECK (estado IN ('en_transito', 'confirmada', 'rechazada', 'cancelada'));

ALTER TABLE stock_transferencias
  ADD COLUMN IF NOT EXISTS fecha_confirmacion TIMESTAMPTZ;

ALTER TABLE stock_transferencias
  ADD COLUMN IF NOT EXISTS confirmado_por INTEGER REFERENCES usuarios(id);

ALTER TABLE stock_transferencias
  ADD COLUMN IF NOT EXISTS rechazado_motivo TEXT;

ALTER TABLE stock_transferencias
  ADD COLUMN IF NOT EXISTS cancelado_motivo TEXT;

-- Las existentes (creadas por fn_transferir_stock_local antiguo) quedan como
-- 'confirmada' porque sí tenían los 2 movimientos. El default lo cubre.

CREATE INDEX IF NOT EXISTS idx_transf_pendientes_destino
  ON stock_transferencias(tenant_id, local_destino_id, estado)
  WHERE estado = 'en_transito' AND deleted_at IS NULL;

-- ─── 2. RPC: iniciar traspaso (origen → en tránsito) ──────────────────────
CREATE OR REPLACE FUNCTION fn_iniciar_traspaso(
  p_insumo_id BIGINT,
  p_local_origen_id INTEGER,
  p_local_destino_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_insumo RECORD;
  v_transf_id BIGINT;
  v_mov_origen_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  -- Validar inputs
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN RAISE EXCEPTION 'CANTIDAD_INVALIDA'; END IF;
  IF p_local_origen_id = p_local_destino_id THEN RAISE EXCEPTION 'LOCALES_IGUALES'; END IF;

  -- Insumo
  SELECT id, nombre, COALESCE(costo_actual, 0) AS costo, COALESCE(stock_actual, 0) AS stock
    INTO v_insumo
    FROM insumos
   WHERE id = p_insumo_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL;
  IF v_insumo IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  -- Validar locales pertenecen al tenant
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_origen_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_destino_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO';
  END IF;

  -- Permisos: operador debe poder ver el local ORIGEN (es quien entrega)
  IF NOT (auth_es_dueno_o_admin() OR p_local_origen_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_ORIGEN';
  END IF;

  -- Saldo disponible en origen
  IF v_insumo.stock < p_cantidad THEN
    RAISE EXCEPTION 'STOCK_INSUFICIENTE';
  END IF;

  -- Crear header en estado 'en_transito'
  INSERT INTO stock_transferencias (
    tenant_id, insumo_id, local_origen_id, local_destino_id,
    cantidad, costo_unitario, motivo, usuario_id, estado
  ) VALUES (
    v_tenant_id, p_insumo_id, p_local_origen_id, p_local_destino_id,
    p_cantidad, v_insumo.costo, p_motivo, v_user_id, 'en_transito'
  ) RETURNING id INTO v_transf_id;

  -- Movimiento origen (-cantidad). El stock baja YA en origen.
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id
  ) VALUES (
    v_tenant_id, p_local_origen_id, p_insumo_id, 'transferencia_local',
    -p_cantidad, v_insumo.costo,
    'Envío en tránsito a local destino' || COALESCE(': ' || p_motivo, ''),
    'transferencia', v_transf_id, v_user_id
  ) RETURNING id INTO v_mov_origen_id;

  -- Guardar referencia al movimiento origen (destino_id queda NULL hasta confirmar)
  UPDATE stock_transferencias SET movimiento_origen_id = v_mov_origen_id WHERE id = v_transf_id;

  RETURN v_transf_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_iniciar_traspaso(BIGINT, INTEGER, INTEGER, NUMERIC, TEXT) TO authenticated;

-- ─── 3. RPC: confirmar recepción (destino acepta) ─────────────────────────
CREATE OR REPLACE FUNCTION fn_confirmar_recepcion_traspaso(
  p_transferencia_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_transf RECORD;
  v_mov_destino_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  -- Cargar traspaso + lock optimista
  SELECT * INTO v_transf
    FROM stock_transferencias
   WHERE id = p_transferencia_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF v_transf IS NULL THEN RAISE EXCEPTION 'TRANSFERENCIA_NO_ENCONTRADA'; END IF;

  IF v_transf.estado <> 'en_transito' THEN
    RAISE EXCEPTION 'TRANSFERENCIA_NO_PENDIENTE';
  END IF;

  -- Quien confirma debe poder ver el local destino (es el receptor)
  IF NOT (auth_es_dueno_o_admin() OR v_transf.local_destino_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_DESTINO';
  END IF;

  -- Movimiento destino (+cantidad). Stock sube YA en destino.
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id
  ) VALUES (
    v_tenant_id, v_transf.local_destino_id, v_transf.insumo_id, 'transferencia_local',
    v_transf.cantidad, COALESCE(v_transf.costo_unitario, 0),
    'Recepción confirmada de local origen' || COALESCE(': ' || v_transf.motivo, ''),
    'transferencia', p_transferencia_id, v_user_id
  ) RETURNING id INTO v_mov_destino_id;

  UPDATE stock_transferencias SET
    estado = 'confirmada',
    fecha_confirmacion = NOW(),
    confirmado_por = v_user_id,
    movimiento_destino_id = v_mov_destino_id
  WHERE id = p_transferencia_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_confirmar_recepcion_traspaso(BIGINT) TO authenticated;

-- ─── 4. RPC: rechazar recepción (destino dice "no llegó bien") ────────────
CREATE OR REPLACE FUNCTION fn_rechazar_recepcion_traspaso(
  p_transferencia_id BIGINT,
  p_motivo TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_transf RECORD;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  IF p_motivo IS NULL OR LENGTH(TRIM(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  SELECT * INTO v_transf
    FROM stock_transferencias
   WHERE id = p_transferencia_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF v_transf IS NULL THEN RAISE EXCEPTION 'TRANSFERENCIA_NO_ENCONTRADA'; END IF;

  IF v_transf.estado <> 'en_transito' THEN
    RAISE EXCEPTION 'TRANSFERENCIA_NO_PENDIENTE';
  END IF;

  -- Quien rechaza debe poder ver el destino (es el receptor)
  IF NOT (auth_es_dueno_o_admin() OR v_transf.local_destino_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_DESTINO';
  END IF;

  -- Devolver stock al origen (+cantidad, tipo entrada_devolucion)
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id
  ) VALUES (
    v_tenant_id, v_transf.local_origen_id, v_transf.insumo_id, 'entrada_devolucion',
    v_transf.cantidad, COALESCE(v_transf.costo_unitario, 0),
    'Rechazo recepción de destino: ' || p_motivo,
    'transferencia', p_transferencia_id, v_user_id
  );

  UPDATE stock_transferencias SET
    estado = 'rechazada',
    fecha_confirmacion = NOW(),
    confirmado_por = v_user_id,
    rechazado_motivo = p_motivo
  WHERE id = p_transferencia_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_rechazar_recepcion_traspaso(BIGINT, TEXT) TO authenticated;

-- ─── 5. RPC: cancelar traspaso (origen se arrepiente, todavía en tránsito) ─
CREATE OR REPLACE FUNCTION fn_cancelar_traspaso(
  p_transferencia_id BIGINT,
  p_motivo TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_transf RECORD;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  SELECT * INTO v_transf
    FROM stock_transferencias
   WHERE id = p_transferencia_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF v_transf IS NULL THEN RAISE EXCEPTION 'TRANSFERENCIA_NO_ENCONTRADA'; END IF;

  IF v_transf.estado <> 'en_transito' THEN
    RAISE EXCEPTION 'TRANSFERENCIA_NO_PENDIENTE';
  END IF;

  -- Cualquiera de los 2 locales puede cancelar mientras está en tránsito
  IF NOT (auth_es_dueno_o_admin()
          OR v_transf.local_origen_id = ANY(auth_locales_visibles())
          OR v_transf.local_destino_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Devolver stock al origen
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id
  ) VALUES (
    v_tenant_id, v_transf.local_origen_id, v_transf.insumo_id, 'entrada_devolucion',
    v_transf.cantidad, COALESCE(v_transf.costo_unitario, 0),
    'Cancelación de traspaso' || COALESCE(': ' || p_motivo, ''),
    'transferencia', p_transferencia_id, v_user_id
  );

  UPDATE stock_transferencias SET
    estado = 'cancelada',
    fecha_confirmacion = NOW(),
    confirmado_por = v_user_id,
    cancelado_motivo = p_motivo
  WHERE id = p_transferencia_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cancelar_traspaso(BIGINT, TEXT) TO authenticated;

-- ─── 6. Vista actualizada con estado ──────────────────────────────────────
-- Drop necesario porque cambiamos el orden y agregamos columnas. CREATE OR
-- REPLACE no permite cambiar la firma de columnas.
DROP VIEW IF EXISTS v_stock_transferencias;
CREATE VIEW v_stock_transferencias
WITH (security_invoker = on) AS
SELECT
  t.id,
  t.tenant_id,
  t.estado,
  t.insumo_id,
  i.nombre AS insumo_nombre,
  i.unidad,
  t.local_origen_id,
  l_o.nombre AS local_origen_nombre,
  t.local_destino_id,
  l_d.nombre AS local_destino_nombre,
  t.cantidad,
  t.costo_unitario,
  (t.cantidad * COALESCE(t.costo_unitario, 0)) AS valor_total,
  t.motivo,
  t.rechazado_motivo,
  t.cancelado_motivo,
  t.usuario_id,
  u_o.nombre AS usuario_origen_nombre,
  t.confirmado_por,
  u_c.nombre AS usuario_confirmador_nombre,
  t.created_at,
  t.fecha_confirmacion
FROM stock_transferencias t
JOIN insumos i ON i.id = t.insumo_id
JOIN locales l_o ON l_o.id = t.local_origen_id
JOIN locales l_d ON l_d.id = t.local_destino_id
LEFT JOIN usuarios u_o ON u_o.id = t.usuario_id
LEFT JOIN usuarios u_c ON u_c.id = t.confirmado_por
WHERE t.deleted_at IS NULL;

GRANT SELECT ON v_stock_transferencias TO authenticated;

NOTIFY pgrst, 'reload schema';
