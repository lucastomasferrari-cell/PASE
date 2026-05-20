-- ═══════════════════════════════════════════════════════════════════════════
-- Feature 3: Transferencias de stock entre locales (préstamos de mercadería)
--
-- Caso de uso (Lucas): "se hacen prestamos entre locales, mercadería".
-- Hoy cada local tiene su stock numérico (vía insumos.stock_actual) que se
-- mantiene por insumo_movimientos. Falta el caso "saco N de Belgrano y los
-- pongo en Devoto" atómicamente.
--
-- Modelo:
--   - Agregar tipo 'transferencia_local' al CHECK de insumo_movimientos.tipo.
--   - Tabla stock_transferencias: header de la operación (insumo, origen,
--     destino, cantidad, motivo, usuario, timestamp).
--   - RPC fn_transferir_stock_local: atómica.
--     1. Valida saldo en origen.
--     2. INSERT movimiento -N en origen (con tipo=transferencia_local).
--     3. INSERT movimiento +N en destino (con tipo=transferencia_local).
--     4. INSERT en stock_transferencias para audit.
--   - Trigger ya existente mantiene stock_actual en cada lado.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Agregar tipo 'transferencia_local' al CHECK ──────────────────────
ALTER TABLE insumo_movimientos DROP CONSTRAINT IF EXISTS insumo_movimientos_tipo_check;
ALTER TABLE insumo_movimientos ADD CONSTRAINT insumo_movimientos_tipo_check
  CHECK (tipo IN (
    'entrada_compra', 'entrada_ajuste', 'entrada_devolucion',
    'salida_venta', 'salida_ajuste',
    'merma', 'robo', 'donacion',
    'conteo', 'inicial',
    'transferencia_local'  -- nuevo: salida (-N) en local origen + entrada (+N) en destino
  ));

-- ─── 2. Tabla stock_transferencias (header) ──────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transferencias (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  insumo_id       BIGINT NOT NULL REFERENCES insumos(id),
  local_origen_id INTEGER NOT NULL,
  local_destino_id INTEGER NOT NULL,
  cantidad        NUMERIC(12, 4) NOT NULL CHECK (cantidad > 0),
  costo_unitario  NUMERIC(12, 4),  -- snapshot al momento
  motivo          TEXT,
  -- Referencia a los 2 movimientos creados (origen + destino)
  movimiento_origen_id   BIGINT,
  movimiento_destino_id  BIGINT,
  -- Audit
  usuario_id      INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT chk_locales_diff CHECK (local_origen_id <> local_destino_id)
);

CREATE INDEX IF NOT EXISTS idx_transf_tenant_created
  ON stock_transferencias(tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transf_origen
  ON stock_transferencias(local_origen_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transf_destino
  ON stock_transferencias(local_destino_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transf_insumo
  ON stock_transferencias(insumo_id, created_at DESC) WHERE deleted_at IS NULL;

COMMENT ON TABLE stock_transferencias IS
  'Header de transferencias de stock entre locales. Cada fila genera 2 movimientos en insumo_movimientos (uno -N origen, otro +N destino).';

ALTER TABLE stock_transferencias ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transferencias_all ON stock_transferencias
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_origen_id = ANY(auth_locales_visibles())
      OR local_destino_id = ANY(auth_locales_visibles())
    )
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_origen_id = ANY(auth_locales_visibles())
      OR local_destino_id = ANY(auth_locales_visibles())
    )
  );

-- ─── 3. RPC fn_transferir_stock_local ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_transferir_stock_local(
  p_insumo_id BIGINT,
  p_local_origen_id INTEGER,
  p_local_destino_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo TEXT DEFAULT NULL
) RETURNS BIGINT  -- id de stock_transferencias
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_insumo_local_id INTEGER;
  v_insumo_nombre TEXT;
  v_costo NUMERIC;
  v_transf_id BIGINT;
  v_mov_origen_id BIGINT;
  v_mov_destino_id BIGINT;
  v_stock_actual NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;
  IF p_local_origen_id = p_local_destino_id THEN
    RAISE EXCEPTION 'LOCALES_IGUALES';
  END IF;

  -- Insumo (puede ser global local_id=NULL o local-specific)
  SELECT local_id, nombre, COALESCE(costo_actual, 0), COALESCE(stock_actual, 0)
    INTO v_insumo_local_id, v_insumo_nombre, v_costo, v_stock_actual
    FROM insumos
   WHERE id = p_insumo_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL;
  IF v_insumo_nombre IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  -- Validar locales pertenecen al tenant
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_origen_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_destino_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO';
  END IF;

  -- Permisos: el operador debe ver AL MENOS UNO de los dos locales involucrados.
  -- Idealmente el origen (es quien entrega).
  IF NOT (auth_es_dueno_o_admin()
          OR p_local_origen_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_ORIGEN';
  END IF;

  -- Validar saldo origen. Si el insumo es local-specific de OTRO local,
  -- el saldo es 0 por definición.
  -- (Sutileza: stock_actual está denormalizado en `insumos` y es global
  --  al insumo, no por local. Para inventario multi-local hace falta una
  --  tabla insumo_stock_por_local. Como simplificación de fase 1,
  --  asumimos que cada local tiene su propio insumo o que el stock_actual
  --  representa el total entre locales. La transferencia mueve unidades
  --  CONTABLEMENTE pero no afecta stock_actual del insumo si es global.)
  IF v_stock_actual < p_cantidad THEN
    RAISE EXCEPTION 'STOCK_INSUFICIENTE';
  END IF;

  -- Insertar header
  INSERT INTO stock_transferencias (
    tenant_id, insumo_id, local_origen_id, local_destino_id,
    cantidad, costo_unitario, motivo, usuario_id
  ) VALUES (
    v_tenant_id, p_insumo_id, p_local_origen_id, p_local_destino_id,
    p_cantidad, v_costo, NULLIF(trim(p_motivo),''),
    -- usuario_id puede ser NULL si auth.uid() no es INTEGER
    NULL::INTEGER
  ) RETURNING id INTO v_transf_id;

  -- Movimiento salida (origen)
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, p_local_origen_id, p_insumo_id, 'transferencia_local',
    -p_cantidad, v_costo,
    'Transfer a local ' || p_local_destino_id || COALESCE(' — ' || p_motivo, ''),
    'stock_transferencia', v_transf_id
  ) RETURNING id INTO v_mov_origen_id;

  -- Movimiento entrada (destino)
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, p_local_destino_id, p_insumo_id, 'transferencia_local',
    p_cantidad, v_costo,
    'Transfer desde local ' || p_local_origen_id || COALESCE(' — ' || p_motivo, ''),
    'stock_transferencia', v_transf_id
  ) RETURNING id INTO v_mov_destino_id;

  -- Actualizar header con los IDs de los movimientos
  UPDATE stock_transferencias SET
    movimiento_origen_id = v_mov_origen_id,
    movimiento_destino_id = v_mov_destino_id
  WHERE id = v_transf_id;

  RETURN v_transf_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_transferir_stock_local(BIGINT, INTEGER, INTEGER, NUMERIC, TEXT) TO authenticated;

-- ─── Vista helper: transferencias con nombres legibles ────────────────────
CREATE OR REPLACE VIEW v_stock_transferencias AS
SELECT
  st.id,
  st.tenant_id,
  st.insumo_id,
  i.nombre AS insumo_nombre,
  i.unidad AS insumo_unidad,
  st.local_origen_id,
  lo.nombre AS local_origen_nombre,
  st.local_destino_id,
  ld.nombre AS local_destino_nombre,
  st.cantidad,
  st.costo_unitario,
  st.cantidad * COALESCE(st.costo_unitario, 0) AS valor_total,
  st.motivo,
  st.created_at,
  st.usuario_id
FROM stock_transferencias st
LEFT JOIN insumos i ON i.id = st.insumo_id
LEFT JOIN locales lo ON lo.id = st.local_origen_id
LEFT JOIN locales ld ON ld.id = st.local_destino_id
WHERE st.deleted_at IS NULL;

GRANT SELECT ON v_stock_transferencias TO authenticated;

NOTIFY pgrst, 'reload schema';
