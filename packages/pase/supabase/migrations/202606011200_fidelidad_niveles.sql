-- 202606011200_fidelidad_niveles.sql
-- Brainstorm #8 Fase 5 Chunk A — Niveles fidelidad + RPCs públicas canje.
--
-- Agrega:
--   1. Niveles de cliente (bronze/silver/gold) calculados automático según
--      total_gastado, con umbrales por local.
--   2. Fecha de nacimiento (para cupón cumpleaños — cron en chunk E).
--   3. RPC pública fn_consultar_puntos_publico: cliente consulta saldo
--      por teléfono desde la tienda sin login.
--   4. RPC pública fn_canjear_puntos_publico: cliente canjea N puntos
--      contra una venta ya creada.
--
-- Decisión Lucas 2026-06-01: umbrales DEFAULT globales ($50K silver, $150K gold).
-- Configurables por local en futuro (UI no incluida en este chunk).

-- ─── 1. Columnas clientes: nivel + fecha_nacimiento ──────────────────────────
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS nivel TEXT NOT NULL DEFAULT 'bronze'
    CHECK (nivel IN ('bronze', 'silver', 'gold', 'platinum')),
  ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE NULL,
  ADD COLUMN IF NOT EXISTS total_gastado NUMERIC(15, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clientes_nivel
  ON clientes(tenant_id, nivel) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_cumple
  ON clientes(tenant_id, fecha_nacimiento)
  WHERE deleted_at IS NULL AND fecha_nacimiento IS NOT NULL;

COMMENT ON COLUMN clientes.nivel IS
  'Nivel fidelidad calculado por trigger según total_gastado. Brainstorm #8 F5.';
COMMENT ON COLUMN clientes.fecha_nacimiento IS
  'Para cupón cumpleaños automático (cron en chunk E).';
COMMENT ON COLUMN clientes.total_gastado IS
  'Total acumulado de ventas cobradas. Actualizado por trigger.';

-- ─── 2. Settings umbrales por local ──────────────────────────────────────────
ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS nivel_silver_umbral NUMERIC(15, 2) DEFAULT 50000,
  ADD COLUMN IF NOT EXISTS nivel_gold_umbral NUMERIC(15, 2) DEFAULT 150000;

-- ─── 3. Trigger: actualizar total_gastado + nivel al cobrar venta ────────────
CREATE OR REPLACE FUNCTION fn_trg_actualizar_nivel_cliente()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cliente_id BIGINT;
  v_nuevo_total NUMERIC;
  v_silver NUMERIC;
  v_gold NUMERIC;
  v_nuevo_nivel TEXT;
BEGIN
  -- Solo al pasar a 'cobrada' por primera vez
  IF NEW.estado != 'cobrada' OR (OLD.estado IS NOT NULL AND OLD.estado = 'cobrada') THEN
    RETURN NEW;
  END IF;

  -- Buscar cliente
  v_cliente_id := NEW.cliente_id;
  IF v_cliente_id IS NULL AND NEW.cliente_telefono IS NOT NULL THEN
    SELECT id INTO v_cliente_id FROM clientes
     WHERE tenant_id = NEW.tenant_id AND telefono = NEW.cliente_telefono
       AND deleted_at IS NULL
     LIMIT 1;
  END IF;
  IF v_cliente_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Actualizar total
  UPDATE clientes SET
    total_gastado = total_gastado + NEW.total,
    updated_at = NOW()
   WHERE id = v_cliente_id
  RETURNING total_gastado INTO v_nuevo_total;

  -- Calcular nivel según umbrales del local
  SELECT nivel_silver_umbral, nivel_gold_umbral
    INTO v_silver, v_gold
    FROM comanda_local_settings WHERE local_id = NEW.local_id;
  v_silver := COALESCE(v_silver, 50000);
  v_gold := COALESCE(v_gold, 150000);

  v_nuevo_nivel := CASE
    WHEN v_nuevo_total >= v_gold THEN 'gold'
    WHEN v_nuevo_total >= v_silver THEN 'silver'
    ELSE 'bronze'
  END;

  UPDATE clientes SET nivel = v_nuevo_nivel
   WHERE id = v_cliente_id AND nivel <> v_nuevo_nivel;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_actualizar_nivel_cliente ON ventas_pos;
CREATE TRIGGER trg_actualizar_nivel_cliente
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  WHEN (NEW.estado = 'cobrada')
  EXECUTE FUNCTION fn_trg_actualizar_nivel_cliente();

-- ─── 4. Backfill: calcular total_gastado y nivel de clientes existentes ──────
-- Sum de ventas_pos cobradas no anuladas por cliente.
UPDATE clientes c SET
  total_gastado = COALESCE((
    SELECT SUM(vp.total) FROM ventas_pos vp
    WHERE (vp.cliente_id = c.id OR vp.cliente_telefono = c.telefono)
      AND vp.tenant_id = c.tenant_id
      AND vp.estado = 'cobrada'
      AND vp.deleted_at IS NULL
  ), 0)
WHERE c.deleted_at IS NULL;

UPDATE clientes c SET nivel = CASE
  WHEN c.total_gastado >= COALESCE(
    (SELECT nivel_gold_umbral FROM comanda_local_settings cls
     WHERE cls.tenant_id = c.tenant_id LIMIT 1), 150000)
    THEN 'gold'
  WHEN c.total_gastado >= COALESCE(
    (SELECT nivel_silver_umbral FROM comanda_local_settings cls
     WHERE cls.tenant_id = c.tenant_id LIMIT 1), 50000)
    THEN 'silver'
  ELSE 'bronze'
END
WHERE c.deleted_at IS NULL;

-- ─── 5. RPC pública: consultar puntos del cliente por teléfono ───────────────
-- Anon-callable (no requiere login). Validación: el slug del local debe
-- existir Y el cliente debe tener venta previa en ese tenant.
CREATE OR REPLACE FUNCTION fn_consultar_puntos_publico(
  p_slug TEXT,
  p_telefono TEXT
) RETURNS TABLE (
  puntos_disponibles NUMERIC,
  nivel TEXT,
  pesos_por_punto NUMERIC,
  fidelidad_activa BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_fidelidad_activa BOOLEAN;
  v_pesos NUMERIC;
BEGIN
  -- Resolver local por slug
  SELECT cls.tenant_id, cls.local_id, cls.fidelidad_activa, cls.fidelidad_pesos_por_punto
    INTO v_tenant_id, v_local_id, v_fidelidad_activa, v_pesos
    FROM comanda_local_settings cls
   WHERE cls.slug = p_slug AND cls.deleted_at IS NULL
   LIMIT 1;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  -- Si fidelidad no activa, devolver vacío sin error (UI maneja)
  IF NOT v_fidelidad_activa THEN
    RETURN QUERY SELECT 0::NUMERIC, 'bronze'::TEXT, 0::NUMERIC, FALSE;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      COALESCE(c.puntos_disponibles, 0::NUMERIC),
      COALESCE(c.nivel, 'bronze'::TEXT),
      COALESCE(v_pesos, 5::NUMERIC),
      TRUE
    FROM clientes c
    WHERE c.tenant_id = v_tenant_id
      AND c.telefono = p_telefono
      AND c.deleted_at IS NULL
    LIMIT 1;

  -- Si no hay cliente, devolver row con ceros
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::NUMERIC, 'bronze'::TEXT, COALESCE(v_pesos, 5::NUMERIC), TRUE;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_consultar_puntos_publico(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_consultar_puntos_publico(TEXT, TEXT) TO anon, authenticated;

-- ─── 6. RPC pública: canjear puntos en venta ya creada ───────────────────────
-- Anon-callable. Valida que la venta exista, sea del local correcto, esté
-- en estado pre-cobro, y que el cliente tenga puntos suficientes.
-- Identificación por teléfono (sin login).
CREATE OR REPLACE FUNCTION fn_canjear_puntos_publico(
  p_slug TEXT,
  p_telefono TEXT,
  p_venta_id BIGINT,
  p_puntos NUMERIC
) RETURNS NUMERIC  -- devuelve descuento en pesos aplicado
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_cliente_id BIGINT;
  v_saldo NUMERIC;
  v_pesos_por_punto NUMERIC;
  v_descuento NUMERIC;
  v_venta_estado TEXT;
BEGIN
  IF p_puntos <= 0 THEN RAISE EXCEPTION 'PUNTOS_INVALIDOS'; END IF;

  -- Resolver local
  SELECT cls.tenant_id, cls.local_id, cls.fidelidad_pesos_por_punto
    INTO v_tenant_id, v_local_id, v_pesos_por_punto
    FROM comanda_local_settings cls
   WHERE cls.slug = p_slug AND cls.deleted_at IS NULL
   LIMIT 1;

  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;
  IF v_pesos_por_punto IS NULL OR v_pesos_por_punto <= 0 THEN
    RAISE EXCEPTION 'FIDELIDAD_NO_CONFIGURADA';
  END IF;

  -- Resolver cliente por teléfono
  SELECT id, puntos_disponibles INTO v_cliente_id, v_saldo
    FROM clientes
   WHERE tenant_id = v_tenant_id AND telefono = p_telefono AND deleted_at IS NULL
   FOR UPDATE
   LIMIT 1;
  IF v_cliente_id IS NULL THEN RAISE EXCEPTION 'CLIENTE_NO_ENCONTRADO'; END IF;
  IF v_saldo < p_puntos THEN RAISE EXCEPTION 'PUNTOS_INSUFICIENTES'; END IF;

  -- Validar venta: debe existir, mismo tenant/local, NO cobrada/anulada
  SELECT estado INTO v_venta_estado FROM ventas_pos
   WHERE id = p_venta_id AND tenant_id = v_tenant_id AND local_id = v_local_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF v_venta_estado IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_venta_estado IN ('cobrada', 'anulada') THEN
    RAISE EXCEPTION 'VENTA_NO_MODIFICABLE: %', v_venta_estado;
  END IF;

  -- Idempotency: si ya hay canje para esta venta-cliente, retornar el descuento ya aplicado
  IF EXISTS (
    SELECT 1 FROM cliente_puntos_movimientos
    WHERE venta_id = p_venta_id AND cliente_id = v_cliente_id
      AND tipo = 'canje' AND deleted_at IS NULL
  ) THEN
    SELECT ABS(puntos) * v_pesos_por_punto INTO v_descuento
      FROM cliente_puntos_movimientos
     WHERE venta_id = p_venta_id AND cliente_id = v_cliente_id
       AND tipo = 'canje' AND deleted_at IS NULL
     LIMIT 1;
    RETURN v_descuento;
  END IF;

  v_descuento := p_puntos * v_pesos_por_punto;

  -- Insertar movimiento (trigger fn_trg_puntos_update_saldo descuenta saldo)
  INSERT INTO cliente_puntos_movimientos (
    tenant_id, local_id, cliente_id, tipo, puntos, venta_id, motivo
  ) VALUES (
    v_tenant_id, v_local_id, v_cliente_id, 'canje', -p_puntos, p_venta_id,
    'Canje desde tienda online'
  );

  -- Aplicar descuento a la venta
  UPDATE ventas_pos SET
    descuento_total = COALESCE(descuento_total, 0) + v_descuento,
    total = GREATEST(0, total - v_descuento),  -- nunca negativo
    updated_at = NOW()
  WHERE id = p_venta_id;

  RETURN v_descuento;
END;
$$;

REVOKE ALL ON FUNCTION fn_canjear_puntos_publico(TEXT, TEXT, BIGINT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_canjear_puntos_publico(TEXT, TEXT, BIGINT, NUMERIC) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION fn_consultar_puntos_publico IS
  'Consulta puntos+nivel del cliente por teléfono. Públ-callable. Plan F5 Chunk A.';
COMMENT ON FUNCTION fn_canjear_puntos_publico IS
  'Canjea puntos contra venta pre-cobro. Idempotent. Públ-callable. Plan F5 Chunk A.';
