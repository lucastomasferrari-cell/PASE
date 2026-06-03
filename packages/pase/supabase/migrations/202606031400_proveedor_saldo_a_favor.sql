-- 202606031400_proveedor_saldo_a_favor.sql
-- Pedido Lucas/Agos 03-jun: cuando se paga de más o de menos a un
-- proveedor, hoy el extra/faltante desaparece del sistema (la factura
-- se cierra y listo). Resultado: si Anto paga $120k por una factura
-- de $100k, los $20k extra los olvidás → perdés saldo a favor.
--
-- Modelo nuevo:
--   1. Cada vez que se paga != saldo_pendiente de una factura Y el user
--      marca "generar saldo", se crea movimiento en proveedor_saldo_movimientos
--      con tipo 'a_favor' (pago de más) o 'en_contra' (pago de menos).
--   2. `proveedores.saldo_a_favor` es el cache derivado (positivo = nos
--      deben, negativo = les debemos). Mantenido por trigger.
--   3. NC/ND oficiales NO afectan el saldo (siguen como hoy, fiscal pero
--      no operativo) — Lucas: "es otra cosa, va al contador y chau".
--
-- Próximo paso (otra ronda): "USAR" el saldo a favor en pagos futuros
-- como crédito. Hoy solo se acumula y se ve en estado de cuenta.

-- ─── 1. Tabla ledger append-only ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proveedor_saldo_movimientos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT auth_tenant_id() REFERENCES tenants(id),
  proveedor_id  TEXT NOT NULL REFERENCES proveedores(id),
  fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
  -- 'a_favor' = el proveedor nos debe (pagamos de más).
  -- 'en_contra' = le debemos al proveedor (pagamos de menos cerrando factura).
  tipo          TEXT NOT NULL CHECK (tipo IN ('a_favor', 'en_contra', 'ajuste_a_favor', 'ajuste_en_contra')),
  -- Siempre positivo. El signo lo define el `tipo`.
  monto         NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
  motivo        TEXT NULL,
  -- Link opcional al pago/factura que lo generó (para auditoría).
  factura_id    TEXT NULL REFERENCES facturas(id),
  movimiento_id TEXT NULL REFERENCES movimientos(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INTEGER NULL REFERENCES usuarios(id),
  -- Soft-delete por si hay que revertir un saldo cargado por error.
  deleted_at    TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_psm_proveedor
  ON proveedor_saldo_movimientos(proveedor_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_psm_tenant
  ON proveedor_saldo_movimientos(tenant_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE proveedor_saldo_movimientos IS
  'Ledger del saldo operativo del proveedor (a favor / en contra). ' ||
  'NO incluye NC/ND oficiales — esas son documentos fiscales paralelos.';

-- RLS multi-tenant + local.
ALTER TABLE proveedor_saldo_movimientos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS psm_scope ON proveedor_saldo_movimientos;
CREATE POLICY psm_scope ON proveedor_saldo_movimientos FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

-- ─── 2. Cache en proveedores ─────────────────────────────────────────────
-- Positivo = proveedor nos debe (saldo a favor nuestro).
-- Negativo = le debemos al proveedor (saldo en contra).
-- 0 = parejos.
ALTER TABLE proveedores
  ADD COLUMN IF NOT EXISTS saldo_a_favor NUMERIC(14, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN proveedores.saldo_a_favor IS
  'Cache derivado de proveedor_saldo_movimientos. ' ||
  'Positivo = nos debe, negativo = le debemos. NO incluye NC/ND oficiales.';

-- ─── 3. Trigger que mantiene el cache ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_proveedor_saldo_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proveedor_id TEXT;
BEGIN
  v_proveedor_id := COALESCE(NEW.proveedor_id, OLD.proveedor_id);
  IF v_proveedor_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Recalcular desde cero (más simple que sumar deltas — la tabla es chica).
  UPDATE proveedores SET saldo_a_favor = COALESCE((
    SELECT SUM(
      CASE WHEN tipo IN ('a_favor', 'ajuste_a_favor') THEN monto
           ELSE -monto END
    )
    FROM proveedor_saldo_movimientos
    WHERE proveedor_id = v_proveedor_id AND deleted_at IS NULL
  ), 0)
  WHERE id = v_proveedor_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_psm_cache ON proveedor_saldo_movimientos;
CREATE TRIGGER trg_psm_cache
  AFTER INSERT OR UPDATE OR DELETE ON proveedor_saldo_movimientos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_proveedor_saldo_cache();

-- ─── 4. pagar_factura modificada ─────────────────────────────────────────
-- Nuevos parámetros:
--   p_generar_saldo: si TRUE y hay diferencia entre p_monto y saldo factura,
--     genera movimiento en proveedor_saldo_movimientos.
--   p_cerrar_factura: si TRUE y p_monto < saldo factura, igual marca la
--     factura como 'pagada' (el faltante queda como saldo_en_contra).
--
-- Comportamiento legacy (cuando ambos defaults FALSE): idéntico a antes.

CREATE OR REPLACE FUNCTION pagar_factura(
  p_factura_id text,
  p_monto numeric,
  p_cuenta text,
  p_fecha date,
  p_detalle text DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_generar_saldo BOOLEAN DEFAULT FALSE,
  p_cerrar_factura BOOLEAN DEFAULT FALSE
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fac RECORD; v_mov_id text; v_tenant uuid;
  v_existing_mov RECORD; v_nuevos_pagos jsonb; v_total_pagado numeric; v_nuevo_estado text;
  v_detalle text;
  v_saldo_pendiente numeric;
  v_excedente numeric := 0;
  v_faltante numeric := 0;
  v_psm_id BIGINT := NULL;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, fact_id INTO v_existing_mov FROM movimientos
    WHERE idempotency_key = p_idempotency_key
      AND tipo = 'Pago Proveedor'
      AND fact_id = p_factura_id;
    IF v_existing_mov.id IS NOT NULL THEN
      SELECT estado INTO v_nuevo_estado FROM facturas WHERE id = p_factura_id;
      RETURN jsonb_build_object(
        'mov_id', v_existing_mov.id,
        'nuevo_estado', v_nuevo_estado,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  -- Saldo pendiente de la factura ANTES de este pago.
  v_saldo_pendiente := v_fac.total - COALESCE((
    SELECT SUM((e->>'monto')::numeric) FROM jsonb_array_elements(COALESCE(v_fac.pagos, '[]'::jsonb)) e
  ), 0);

  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('cuenta', p_cuenta, 'monto', p_monto, 'fecha', p_fecha));
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;

  -- ── Lógica de saldo a favor / en contra (Lucas 03-jun) ──────────────
  IF p_monto > v_saldo_pendiente THEN
    -- Pago de MÁS: factura queda pagada + excedente como saldo a favor.
    v_excedente := p_monto - v_saldo_pendiente;
    v_nuevo_estado := 'pagada';
    IF p_generar_saldo AND v_fac.prov_id IS NOT NULL THEN
      INSERT INTO proveedor_saldo_movimientos (
        tenant_id, proveedor_id, fecha, tipo, monto, motivo, factura_id, created_by
      ) VALUES (
        v_tenant, v_fac.prov_id, p_fecha, 'a_favor', v_excedente,
        'Pago de más sobre factura ' || COALESCE(v_fac.nro, v_fac.id),
        p_factura_id, auth_usuario_id()
      ) RETURNING id INTO v_psm_id;
    END IF;
  ELSIF p_monto < v_saldo_pendiente AND p_cerrar_factura THEN
    -- Pago de MENOS + user marcó "cerrar": factura pagada + faltante en contra.
    v_faltante := v_saldo_pendiente - p_monto;
    v_nuevo_estado := 'pagada';
    IF p_generar_saldo AND v_fac.prov_id IS NOT NULL THEN
      INSERT INTO proveedor_saldo_movimientos (
        tenant_id, proveedor_id, fecha, tipo, monto, motivo, factura_id, created_by
      ) VALUES (
        v_tenant, v_fac.prov_id, p_fecha, 'en_contra', v_faltante,
        'Pago de menos cerrando factura ' || COALESCE(v_fac.nro, v_fac.id),
        p_factura_id, auth_usuario_id()
      ) RETURNING id INTO v_psm_id;
    END IF;
  ELSE
    -- Comportamiento original: ESTADO según total acumulado vs total factura.
    v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;
  END IF;

  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos WHERE id = p_factura_id;

  IF v_fac.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_fac.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  v_detalle := COALESCE(p_detalle, 'Pago Fact ' || COALESCE(v_fac.nro, v_fac.id));
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle, fact_id, local_id, tenant_id,
    idempotency_key
  ) VALUES (
    v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_fac.cat,
    -p_monto, v_detalle, p_factura_id, v_fac.local_id, v_tenant,
    p_idempotency_key
  );

  -- Linkear el movimiento al ledger de saldo (para auditoría).
  IF v_psm_id IS NOT NULL THEN
    UPDATE proveedor_saldo_movimientos SET movimiento_id = v_mov_id WHERE id = v_psm_id;
  END IF;

  PERFORM _auditar('facturas', 'PAGO', jsonb_build_object(
    'factura_id', p_factura_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado,
    'excedente', v_excedente, 'faltante', v_faltante,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object(
    'mov_id', v_mov_id,
    'nuevo_estado', v_nuevo_estado,
    'total_pagado', v_total_pagado,
    'excedente', v_excedente,
    'faltante', v_faltante,
    'saldo_movimiento_id', v_psm_id
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
