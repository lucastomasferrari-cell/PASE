-- ═══════════════════════════════════════════════════════════════════════════
-- Stock numérico + movimientos
--
-- Hasta hoy COMANDA tenía sólo "stock_disponible BOOLEAN" (auto-86). Para
-- control real de inventario sumamos:
--   - insumos.stock_actual  → cantidad numérica actual (cache, recalculable)
--   - insumos.stock_minimo  → umbral de alerta (NULL = sin alerta)
--   - insumos.stock_maximo  → para reportes de sobrestock (opcional)
--   - insumos.unidad_compra → presentación en la que se compra (caja 1L, bolsa 500g, etc)
--                              y `factor_compra` para convertir a unidad canónica.
--
-- Tabla insumo_movimientos: append-only. Cada cambio de stock (entrada,
-- salida, ajuste, conteo) genera una fila. Trigger AFTER INSERT mantiene
-- `insumos.stock_actual` actualizado sumando todos los movimientos.
--
-- Esto da audit trail completo + rollback (basta con borrar el movimiento
-- erróneo + recalcular).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Columnas nuevas en insumos ─────────────────────────────────────────
ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS stock_actual NUMERIC(12, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_minimo NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS stock_maximo NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS ubicacion TEXT;

COMMENT ON COLUMN insumos.stock_actual IS
  'Cantidad actual en stock (en unidad canónica del insumo). Cache mantenido por trigger sobre insumo_movimientos. Recalculable con fn_recalcular_stock_insumo.';
COMMENT ON COLUMN insumos.stock_minimo IS
  'Umbral mínimo para alertar. NULL = sin alerta. Si stock_actual < stock_minimo aparece en v_insumos_alertas_stock.';
COMMENT ON COLUMN insumos.stock_maximo IS
  'Umbral máximo para detectar sobrestock. Solo informativo. NULL = sin alerta.';
COMMENT ON COLUMN insumos.ubicacion IS
  'Texto libre: cámara fría, estante A3, congelador, etc. Para que el conteo físico sea fácil.';

-- ─── 2. Tabla insumo_movimientos (append-only audit) ──────────────────────
CREATE TABLE IF NOT EXISTS insumo_movimientos (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  local_id        INTEGER,
  insumo_id       BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  -- Tipo del movimiento (DETERMINA el signo de la cantidad):
  --   entrada_compra   → +N (compra al proveedor / factura)
  --   entrada_ajuste   → +N (correción manual al alza)
  --   entrada_devolucion → +N (cliente devolvió producto)
  --   salida_venta     → -N (decrement automático al cobrar venta con receta)
  --   salida_ajuste    → -N (corrección manual a la baja)
  --   merma            → -N (perdida por vencimiento / rotura)
  --   robo             → -N (faltante por robo, requiere manager_id)
  --   donacion         → -N (donado al staff o caridad)
  --   conteo           → ±N (diferencia detectada en arqueo físico)
  --   inicial          → +N (carga inicial al activar el sistema)
  tipo            TEXT NOT NULL CHECK (tipo IN (
    'entrada_compra', 'entrada_ajuste', 'entrada_devolucion',
    'salida_venta', 'salida_ajuste',
    'merma', 'robo', 'donacion',
    'conteo', 'inicial'
  )),
  -- Cantidad ya con su signo (positivo = entrada, negativo = salida)
  cantidad        NUMERIC(12, 4) NOT NULL CHECK (cantidad <> 0),
  -- Costo unitario al momento del movimiento (snapshot).
  -- Para entradas: del proveedor. Para salidas: del costo_actual del insumo.
  -- Permite calcular el COGS exacto y la rotación de stock.
  costo_unitario  NUMERIC(12, 4),
  -- Motivo libre (obligatorio para tipos 'robo','donacion','merma','salida_ajuste','entrada_ajuste')
  motivo          TEXT,
  -- Referencia opcional al hecho que originó el movimiento.
  --   fuente_tipo='venta_pos'   fuente_id=venta_pos.id
  --   fuente_tipo='factura'     fuente_id=facturas.id (compra al proveedor)
  --   fuente_tipo='conteo'      fuente_id=stock_conteos.id
  fuente_tipo     TEXT,
  fuente_id       BIGINT,
  -- Audit: quién hizo el movimiento (si fue manual)
  usuario_id      INTEGER,
  -- Si es ajuste con manager override, queda registrado para auditoría.
  manager_id      INTEGER,
  -- Stock antes y después del movimiento (snapshot para audit / undo)
  stock_antes     NUMERIC(12, 4),
  stock_despues   NUMERIC(12, 4),

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mov_insumo_created
  ON insumo_movimientos(insumo_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mov_tenant_local
  ON insumo_movimientos(tenant_id, local_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mov_tipo
  ON insumo_movimientos(tipo, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mov_fuente
  ON insumo_movimientos(fuente_tipo, fuente_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE insumo_movimientos IS
  'Audit trail de TODO cambio de stock. Append-only — para revertir, marcar deleted_at NO recalcula. Usar fn_recalcular_stock_insumo después.';

-- ─── 3. RLS ────────────────────────────────────────────────────────────────
ALTER TABLE insumo_movimientos ENABLE ROW LEVEL SECURITY;

CREATE POLICY insumo_mov_all ON insumo_movimientos
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id IS NULL
      OR local_id = ANY(auth_locales_visibles())
    )
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id IS NULL
      OR local_id = ANY(auth_locales_visibles())
    )
  );

-- ─── 4. Trigger: actualizar stock_actual de insumos ────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_insumo_mov_update_stock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_stock_antes NUMERIC(12, 4);
  v_stock_despues NUMERIC(12, 4);
BEGIN
  -- Capturar stock antes del movimiento + actualizar atómicamente
  SELECT stock_actual INTO v_stock_antes FROM insumos WHERE id = NEW.insumo_id FOR UPDATE;
  v_stock_antes := COALESCE(v_stock_antes, 0);
  v_stock_despues := v_stock_antes + NEW.cantidad;

  -- Guardar snapshot en la fila del movimiento (audit)
  NEW.stock_antes := v_stock_antes;
  NEW.stock_despues := v_stock_despues;

  UPDATE insumos SET
    stock_actual = v_stock_despues,
    updated_at = NOW()
  WHERE id = NEW.insumo_id;

  -- Auto-86 inverso: si el stock vuelve a > 0 y estaba en false, NO desmarcamos
  -- automático (puede haber otros insumos faltando). Si el stock pasa a <= 0
  -- forzamos stock_disponible = FALSE (dispara auto-86).
  IF v_stock_despues <= 0 THEN
    UPDATE insumos SET stock_disponible = FALSE
     WHERE id = NEW.insumo_id AND stock_disponible = TRUE;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_insumo_mov_update_stock ON insumo_movimientos;
CREATE TRIGGER trg_insumo_mov_update_stock
  BEFORE INSERT ON insumo_movimientos
  FOR EACH ROW EXECUTE FUNCTION fn_trg_insumo_mov_update_stock();

-- ─── 5. Función recalcular (defensa contra desincronización) ──────────────
CREATE OR REPLACE FUNCTION fn_recalcular_stock_insumo(p_insumo_id BIGINT)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_total NUMERIC(12, 4);
BEGIN
  SELECT COALESCE(SUM(cantidad), 0) INTO v_total
    FROM insumo_movimientos
   WHERE insumo_id = p_insumo_id AND deleted_at IS NULL;

  UPDATE insumos SET stock_actual = v_total, updated_at = NOW()
   WHERE id = p_insumo_id;

  RETURN v_total;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_recalcular_stock_insumo(BIGINT) TO authenticated;

-- ─── 6. Función recalcular MASIVO (todos los insumos de un tenant) ────────
CREATE OR REPLACE FUNCTION fn_recalcular_stock_todos(p_tenant_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_count INTEGER := 0;
BEGIN
  v_tenant_id := COALESCE(p_tenant_id, auth_tenant_id());
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  WITH totales AS (
    SELECT insumo_id, COALESCE(SUM(cantidad), 0) AS total
      FROM insumo_movimientos
     WHERE deleted_at IS NULL
       AND tenant_id = v_tenant_id
     GROUP BY insumo_id
  )
  UPDATE insumos i SET stock_actual = t.total, updated_at = NOW()
    FROM totales t WHERE i.id = t.insumo_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_recalcular_stock_todos(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
