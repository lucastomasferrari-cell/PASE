-- ═══════════════════════════════════════════════════════════════════════════
-- Programa de fidelidad: puntos
--
-- Cada local decide:
--   - fidelidad_activa: BOOLEAN. Si FALSE, no acumula.
--   - puntos_por_peso: por cada $N gastados, 1 punto. Default 100 ($100 → 1pt).
--   - pesos_por_punto: al canjear, 1 punto = $M descuento. Default 5 ($5/pt).
--
-- Acumulación automática: trigger sobre ventas_pos cuando pasa a cobrada,
-- inserta movimiento de puntos al cliente del pedido.
--
-- Canje: RPC explícita fn_canjear_puntos_cliente. Se valida saldo + venta
-- abierta + monto disponible.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Settings por local ────────────────────────────────────────────────────
ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS fidelidad_activa BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fidelidad_puntos_por_peso NUMERIC(8, 4) DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS fidelidad_pesos_por_punto NUMERIC(8, 4) DEFAULT 5;

COMMENT ON COLUMN comanda_local_settings.fidelidad_activa IS
  'Si TRUE, acumula puntos al cobrar ventas. Default FALSE — opt-in.';
COMMENT ON COLUMN comanda_local_settings.fidelidad_puntos_por_peso IS
  'Puntos otorgados por peso gastado. 0.01 = 1pt cada $100. Default 0.01.';
COMMENT ON COLUMN comanda_local_settings.fidelidad_pesos_por_punto IS
  'Equivalencia al canjear: 1 punto = $X. Default $5. Cuanto menor el ratio puntos_por_peso × pesos_por_punto, más caro acumular.';

-- ─── Columnas extra en clientes ────────────────────────────────────────────
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS puntos_disponibles NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clientes_puntos
  ON clientes(tenant_id, puntos_disponibles) WHERE deleted_at IS NULL AND puntos_disponibles > 0;

-- ─── Tabla cliente_puntos_movimientos ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS cliente_puntos_movimientos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  cliente_id    BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  -- tipos:
  --   acumulacion  → +N por compra
  --   canje        → -N para descontar en otra compra
  --   ajuste       → ± manual del local
  --   expiracion   → -N por puntos vencidos
  --   anulacion    → -N revertir acumulación al anular venta
  tipo          TEXT NOT NULL CHECK (tipo IN ('acumulacion', 'canje', 'ajuste', 'expiracion', 'anulacion')),
  puntos        NUMERIC(12, 2) NOT NULL CHECK (puntos <> 0),
  motivo        TEXT,
  -- Referencia a la venta que originó (si aplica)
  venta_id      BIGINT,
  -- Audit
  usuario_id    INTEGER,
  saldo_antes   NUMERIC(12, 2),
  saldo_despues NUMERIC(12, 2),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_puntos_cliente_created
  ON cliente_puntos_movimientos(cliente_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_puntos_venta
  ON cliente_puntos_movimientos(venta_id) WHERE venta_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE cliente_puntos_movimientos ENABLE ROW LEVEL SECURITY;
CREATE POLICY puntos_all ON cliente_puntos_movimientos
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- ─── Trigger: actualizar saldo cliente al insertar movimiento ─────────────
CREATE OR REPLACE FUNCTION fn_trg_puntos_update_saldo()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_saldo_antes NUMERIC(12, 2);
  v_saldo_despues NUMERIC(12, 2);
BEGIN
  SELECT puntos_disponibles INTO v_saldo_antes FROM clientes WHERE id = NEW.cliente_id FOR UPDATE;
  v_saldo_antes := COALESCE(v_saldo_antes, 0);
  v_saldo_despues := v_saldo_antes + NEW.puntos;

  IF v_saldo_despues < 0 THEN
    RAISE EXCEPTION 'PUNTOS_INSUFICIENTES';
  END IF;

  NEW.saldo_antes := v_saldo_antes;
  NEW.saldo_despues := v_saldo_despues;

  UPDATE clientes SET puntos_disponibles = v_saldo_despues, updated_at = NOW()
    WHERE id = NEW.cliente_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_puntos_update_saldo ON cliente_puntos_movimientos;
CREATE TRIGGER trg_puntos_update_saldo
  BEFORE INSERT ON cliente_puntos_movimientos
  FOR EACH ROW EXECUTE FUNCTION fn_trg_puntos_update_saldo();

-- ─── Trigger: acumular puntos al cobrar venta ─────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_acumular_puntos_venta()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_fidelidad_activa BOOLEAN;
  v_puntos_por_peso NUMERIC;
  v_cliente_id BIGINT;
  v_puntos NUMERIC;
BEGIN
  -- Solo cuando pasa a 'cobrada' por primera vez
  IF NEW.estado != 'cobrada' OR (OLD.estado IS NOT NULL AND OLD.estado = 'cobrada') THEN
    RETURN NEW;
  END IF;

  -- ¿Fidelidad activa en el local?
  SELECT fidelidad_activa, fidelidad_puntos_por_peso
    INTO v_fidelidad_activa, v_puntos_por_peso
    FROM comanda_local_settings
   WHERE local_id = NEW.local_id;

  IF NOT v_fidelidad_activa OR v_puntos_por_peso IS NULL OR v_puntos_por_peso <= 0 THEN
    RETURN NEW;
  END IF;

  -- Buscar cliente por teléfono (vinculado en cliente_id o por telefono match)
  v_cliente_id := NEW.cliente_id;
  IF v_cliente_id IS NULL AND NEW.cliente_telefono IS NOT NULL THEN
    SELECT id INTO v_cliente_id FROM clientes
     WHERE tenant_id = NEW.tenant_id AND telefono = NEW.cliente_telefono
       AND deleted_at IS NULL
     LIMIT 1;
  END IF;
  IF v_cliente_id IS NULL THEN
    RETURN NEW; -- sin cliente, no acumulamos
  END IF;

  v_puntos := FLOOR(NEW.total * v_puntos_por_peso);
  IF v_puntos <= 0 THEN RETURN NEW; END IF;

  -- Idempotency: si ya hay acumulación para esta venta, skip
  IF EXISTS (
    SELECT 1 FROM cliente_puntos_movimientos
    WHERE venta_id = NEW.id AND tipo = 'acumulacion' AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO cliente_puntos_movimientos (
    tenant_id, local_id, cliente_id, tipo, puntos, venta_id, motivo
  ) VALUES (
    NEW.tenant_id, NEW.local_id, v_cliente_id, 'acumulacion', v_puntos, NEW.id,
    'Compra venta #' || NEW.numero_local
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acumular_puntos_venta ON ventas_pos;
CREATE TRIGGER trg_acumular_puntos_venta
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  WHEN (NEW.estado = 'cobrada')
  EXECUTE FUNCTION fn_trg_acumular_puntos_venta();

-- ─── RPC: canjear puntos en una venta ──────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_canjear_puntos_cliente(
  p_cliente_id BIGINT,
  p_venta_id BIGINT,
  p_puntos NUMERIC
) RETURNS NUMERIC -- devuelve monto en pesos del descuento aplicado
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_saldo NUMERIC;
  v_pesos_por_punto NUMERIC;
  v_descuento NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF p_puntos <= 0 THEN RAISE EXCEPTION 'PUNTOS_INVALIDOS'; END IF;

  SELECT puntos_disponibles INTO v_saldo FROM clientes
   WHERE id = p_cliente_id AND tenant_id = v_tenant_id AND deleted_at IS NULL FOR UPDATE;
  IF v_saldo IS NULL THEN RAISE EXCEPTION 'CLIENTE_NO_ENCONTRADO'; END IF;
  IF v_saldo < p_puntos THEN RAISE EXCEPTION 'PUNTOS_INSUFICIENTES'; END IF;

  SELECT local_id INTO v_local_id FROM ventas_pos
   WHERE id = p_venta_id AND tenant_id = v_tenant_id AND deleted_at IS NULL FOR UPDATE;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  SELECT fidelidad_pesos_por_punto INTO v_pesos_por_punto
    FROM comanda_local_settings WHERE local_id = v_local_id;
  IF v_pesos_por_punto IS NULL OR v_pesos_por_punto <= 0 THEN
    RAISE EXCEPTION 'FIDELIDAD_NO_CONFIGURADA';
  END IF;

  v_descuento := p_puntos * v_pesos_por_punto;

  INSERT INTO cliente_puntos_movimientos (
    tenant_id, local_id, cliente_id, tipo, puntos, venta_id, motivo,
    usuario_id
  ) VALUES (
    v_tenant_id, v_local_id, p_cliente_id, 'canje', -p_puntos, p_venta_id,
    'Canje en venta #' || p_venta_id,
    auth.uid()::INTEGER
  );

  -- Aplicar el descuento a la venta
  UPDATE ventas_pos SET
    descuento_total = COALESCE(descuento_total, 0) + v_descuento,
    total = total - v_descuento,
    updated_at = NOW()
  WHERE id = p_venta_id;

  RETURN v_descuento;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_canjear_puntos_cliente(BIGINT, BIGINT, NUMERIC) TO authenticated;

-- ─── Trigger reverso: anular venta cobrada → revertir puntos acumulados ──
CREATE OR REPLACE FUNCTION fn_trg_revertir_puntos_anulada()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_mov RECORD;
BEGIN
  IF NEW.estado != 'anulada' OR OLD.estado != 'cobrada' THEN RETURN NEW; END IF;

  FOR v_mov IN
    SELECT * FROM cliente_puntos_movimientos
     WHERE venta_id = NEW.id AND tipo = 'acumulacion' AND deleted_at IS NULL
  LOOP
    -- Idempotency: no doble anular
    IF NOT EXISTS (
      SELECT 1 FROM cliente_puntos_movimientos
      WHERE venta_id = NEW.id AND tipo = 'anulacion' AND cliente_id = v_mov.cliente_id
    ) THEN
      INSERT INTO cliente_puntos_movimientos (
        tenant_id, local_id, cliente_id, tipo, puntos, venta_id, motivo
      ) VALUES (
        v_mov.tenant_id, v_mov.local_id, v_mov.cliente_id, 'anulacion',
        -v_mov.puntos, NEW.id,
        'Reverso anulación venta #' || NEW.id
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revertir_puntos_anulada ON ventas_pos;
CREATE TRIGGER trg_revertir_puntos_anulada
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  WHEN (NEW.estado = 'anulada')
  EXECUTE FUNCTION fn_trg_revertir_puntos_anulada();

NOTIFY pgrst, 'reload schema';
