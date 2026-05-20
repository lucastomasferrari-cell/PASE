-- ═══════════════════════════════════════════════════════════════════════════
-- Cupones / códigos de descuento
--
-- El dueño crea cupones desde admin (/marketing/cupones).
-- En el marketplace checkout, el cliente pega el código → se valida → se
-- aplica como descuento al total.
--
-- Tipos:
--   - porcentaje: ej 10% off (con cap opcional)
--   - monto_fijo: ej $500 off
--
-- Restricciones configurables:
--   - fecha_desde / fecha_hasta
--   - monto_min_compra: requiere venta >= X para aplicar
--   - max_usos: cuántas veces se puede usar en total (NULL = ilimitado)
--   - max_usos_por_cliente: por cliente individual (NULL = ilimitado)
--   - solo_primera_compra: TRUE = solo aplica a clientes sin compras previas
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cupones (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  local_id        INTEGER, -- NULL = aplica a todos los locales del tenant
  code            TEXT NOT NULL,
  descripcion     TEXT,
  tipo            TEXT NOT NULL CHECK (tipo IN ('porcentaje', 'monto_fijo')),
  valor           NUMERIC(12, 2) NOT NULL CHECK (valor > 0),
  -- Para tipo=porcentaje, cap opcional al descuento
  cap_descuento   NUMERIC(12, 2),
  -- Restricciones
  fecha_desde     TIMESTAMPTZ,
  fecha_hasta     TIMESTAMPTZ,
  monto_min_compra NUMERIC(12, 2),
  max_usos        INTEGER,
  max_usos_por_cliente INTEGER,
  solo_primera_compra BOOLEAN DEFAULT FALSE,
  -- Estado
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  usos_actuales   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by      INTEGER,
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT chk_porcentaje_max_100 CHECK (
    tipo != 'porcentaje' OR (valor > 0 AND valor <= 100)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cupones_code_tenant
  ON cupones(tenant_id, UPPER(code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cupones_tenant_activo
  ON cupones(tenant_id, activo) WHERE deleted_at IS NULL;

ALTER TABLE cupones ENABLE ROW LEVEL SECURITY;
CREATE POLICY cupones_all ON cupones
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

-- ─── Tabla cupon_usos (audit) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cupon_usos (
  id            BIGSERIAL PRIMARY KEY,
  cupon_id      BIGINT NOT NULL REFERENCES cupones(id) ON DELETE CASCADE,
  venta_id      BIGINT,
  cliente_id    BIGINT,
  cliente_telefono TEXT,
  descuento_aplicado NUMERIC(12, 2) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cupon_usos_cupon
  ON cupon_usos(cupon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cupon_usos_cliente
  ON cupon_usos(cliente_id) WHERE cliente_id IS NOT NULL;

ALTER TABLE cupon_usos ENABLE ROW LEVEL SECURITY;
CREATE POLICY cupon_usos_all ON cupon_usos
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM cupones c
      WHERE c.id = cupon_usos.cupon_id
        AND c.tenant_id = auth_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM cupones c
      WHERE c.id = cupon_usos.cupon_id
        AND c.tenant_id = auth_tenant_id()
    )
  );

-- ─── Updated_at trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_cupones_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS cupones_updated_at ON cupones;
CREATE TRIGGER cupones_updated_at BEFORE UPDATE ON cupones
  FOR EACH ROW EXECUTE FUNCTION trg_cupones_updated_at();

-- ─── RPC pública: validar cupón (sin aplicar) ─────────────────────────────
--
-- Devuelve el descuento que aplicaría, o motivo de rechazo. Llamada desde
-- el marketplace cuando el cliente pega el código en checkout.
CREATE OR REPLACE FUNCTION fn_validar_cupon(
  p_local_slug TEXT,
  p_code TEXT,
  p_monto_compra NUMERIC,
  p_cliente_telefono TEXT DEFAULT NULL
) RETURNS TABLE (
  valido BOOLEAN,
  motivo TEXT,
  descuento NUMERIC,
  cupon_id BIGINT
) LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_cupon RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_usos_cliente INTEGER;
  v_descuento NUMERIC;
BEGIN
  SELECT cls.local_id, l.tenant_id INTO v_local_id, v_tenant_id
    FROM comanda_local_settings cls
    INNER JOIN locales l ON l.id = cls.local_id
   WHERE cls.slug = p_local_slug AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'LOCAL_NO_ENCONTRADO'::TEXT, 0::NUMERIC, NULL::BIGINT; RETURN;
  END IF;

  -- Resolver cupon (case-insensitive, global o local-specific)
  SELECT * INTO v_cupon FROM cupones
   WHERE tenant_id = v_tenant_id
     AND UPPER(code) = UPPER(trim(p_code))
     AND deleted_at IS NULL
     AND activo = TRUE
     AND (local_id IS NULL OR local_id = v_local_id)
   ORDER BY local_id NULLS LAST
   LIMIT 1;

  IF v_cupon.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'CUPON_INVALIDO'::TEXT, 0::NUMERIC, NULL::BIGINT; RETURN;
  END IF;

  -- Vigencia
  IF v_cupon.fecha_desde IS NOT NULL AND v_now < v_cupon.fecha_desde THEN
    RETURN QUERY SELECT FALSE, 'CUPON_NO_VIGENTE_AUN'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;
  IF v_cupon.fecha_hasta IS NOT NULL AND v_now > v_cupon.fecha_hasta THEN
    RETURN QUERY SELECT FALSE, 'CUPON_VENCIDO'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;

  -- Monto mínimo
  IF v_cupon.monto_min_compra IS NOT NULL AND p_monto_compra < v_cupon.monto_min_compra THEN
    RETURN QUERY SELECT FALSE, 'MONTO_MIN_NO_ALCANZADO'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;

  -- Max usos totales
  IF v_cupon.max_usos IS NOT NULL AND v_cupon.usos_actuales >= v_cupon.max_usos THEN
    RETURN QUERY SELECT FALSE, 'CUPON_AGOTADO'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
  END IF;

  -- Max usos por cliente
  IF v_cupon.max_usos_por_cliente IS NOT NULL AND p_cliente_telefono IS NOT NULL THEN
    SELECT COUNT(*) INTO v_usos_cliente FROM cupon_usos
     WHERE cupon_id = v_cupon.id AND cliente_telefono = p_cliente_telefono;
    IF v_usos_cliente >= v_cupon.max_usos_por_cliente THEN
      RETURN QUERY SELECT FALSE, 'YA_USASTE_ESTE_CUPON'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
  END IF;

  -- Solo primera compra
  IF v_cupon.solo_primera_compra AND p_cliente_telefono IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM ventas_pos v
      WHERE v.tenant_id = v_tenant_id
        AND v.cliente_telefono = p_cliente_telefono
        AND v.estado = 'cobrada'
        AND v.deleted_at IS NULL
    ) THEN
      RETURN QUERY SELECT FALSE, 'SOLO_PRIMERA_COMPRA'::TEXT, 0::NUMERIC, v_cupon.id; RETURN;
    END IF;
  END IF;

  -- Calcular descuento
  IF v_cupon.tipo = 'porcentaje' THEN
    v_descuento := p_monto_compra * (v_cupon.valor / 100.0);
  ELSE
    v_descuento := v_cupon.valor;
  END IF;
  IF v_cupon.cap_descuento IS NOT NULL AND v_descuento > v_cupon.cap_descuento THEN
    v_descuento := v_cupon.cap_descuento;
  END IF;
  -- Nunca más que el monto de la compra
  IF v_descuento > p_monto_compra THEN
    v_descuento := p_monto_compra;
  END IF;

  RETURN QUERY SELECT TRUE, 'OK'::TEXT, v_descuento, v_cupon.id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_validar_cupon(TEXT, TEXT, NUMERIC, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_validar_cupon(TEXT, TEXT, NUMERIC, TEXT) TO authenticated;

-- ─── RPC: aplicar cupón a una venta ───────────────────────────────────────
-- Llamada server-side al crear la venta, o al cerrarla. Registra el uso
-- + incrementa usos_actuales + aplica el descuento al total.
CREATE OR REPLACE FUNCTION fn_aplicar_cupon(
  p_cupon_id BIGINT,
  p_venta_id BIGINT
) RETURNS NUMERIC -- monto descontado
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta RECORD;
  v_resultado RECORD;
  v_descuento NUMERIC;
  v_local_slug TEXT;
BEGIN
  SELECT * INTO v_venta FROM ventas_pos
   WHERE id = p_venta_id AND deleted_at IS NULL FOR UPDATE;
  IF v_venta.id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  SELECT slug INTO v_local_slug FROM comanda_local_settings
   WHERE local_id = v_venta.local_id;
  IF v_local_slug IS NULL THEN RAISE EXCEPTION 'LOCAL_SIN_SLUG'; END IF;

  -- Validar
  SELECT * INTO v_resultado FROM fn_validar_cupon(
    v_local_slug,
    (SELECT code FROM cupones WHERE id = p_cupon_id),
    v_venta.total,
    v_venta.cliente_telefono
  );
  IF NOT v_resultado.valido THEN RAISE EXCEPTION '%', v_resultado.motivo; END IF;

  v_descuento := v_resultado.descuento;

  -- Aplicar al total
  UPDATE ventas_pos SET
    descuento_total = COALESCE(descuento_total, 0) + v_descuento,
    total = GREATEST(0, total - v_descuento),
    updated_at = NOW()
  WHERE id = p_venta_id;

  -- Registrar uso + incrementar contador
  INSERT INTO cupon_usos (cupon_id, venta_id, cliente_id, cliente_telefono, descuento_aplicado)
  VALUES (p_cupon_id, p_venta_id, v_venta.cliente_id, v_venta.cliente_telefono, v_descuento);

  UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE id = p_cupon_id;

  RETURN v_descuento;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_aplicar_cupon(BIGINT, BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
