-- ═══════════════════════════════════════════════════════════════════════════
-- Notas de Crédito — aplicación contra facturas (modelo de uso real).
--
-- Contexto: hasta hoy las NCs se cargaban como `facturas` con
-- tipo='nota_credito'. Restaban del saldo global del proveedor pero NO había
-- forma de aplicarlas a una factura puntual: pagar_factura las ignoraba y
-- las NCs quedaban con estado='pendiente' para siempre, "disponibles" sin
-- distinguir si ya se habían usado o no (bug #32 en código).
--
-- Esta migration introduce:
--   1. Tabla `nc_aplicaciones` (puente NC↔factura, soporta uso parcial).
--   2. RPC `aplicar_nc_a_factura(nc_id, factura_id, monto, fecha)` que:
--      - Valida saldo disponible de la NC (total − SUM aplicaciones).
--      - Valida saldo a pagar de la factura.
--      - Inserta la aplicación, agrega un "pago tipo nc" al array
--        facturas.pagos del lado factura, recalcula estado.
--      - Si la NC queda con saldo 0 → estado='pagada' (consumida).
--      - NO crea movimiento en `movimientos` (no hay flujo de plata real).
--
-- El cálculo de saldo del proveedor (lib/saldoProveedor.ts) sigue funcionando
-- sin cambios: la NC consumida queda con estado='pagada' y deja de aportar;
-- la factura ahora tiene "pagado" parcial (incluye la aplicación de NC) y
-- aporta menos al saldo. Resultado neto: idéntico al modelo viejo, pero
-- ahora rastreable a nivel individual.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1) Tabla puente ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nc_aplicaciones (
  id          BIGSERIAL PRIMARY KEY,
  nc_id       TEXT NOT NULL REFERENCES facturas(id) ON DELETE RESTRICT,
  factura_id  TEXT NOT NULL REFERENCES facturas(id) ON DELETE RESTRICT,
  monto       NUMERIC NOT NULL CHECK (monto > 0),
  fecha       DATE NOT NULL,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id  INTEGER REFERENCES usuarios(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nc_apl_nc_idx       ON nc_aplicaciones(nc_id);
CREATE INDEX IF NOT EXISTS nc_apl_fact_idx     ON nc_aplicaciones(factura_id);
CREATE INDEX IF NOT EXISTS nc_apl_tenant_idx   ON nc_aplicaciones(tenant_id);

-- RLS por tenant. SELECT abierto a authenticated del mismo tenant; INSERT
-- solo a través del RPC (no debería usarse insert directo desde frontend).
ALTER TABLE nc_aplicaciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY nc_apl_select ON nc_aplicaciones FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id());
CREATE POLICY nc_apl_service ON nc_aplicaciones FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE nc_aplicaciones IS
  'Aplicaciones de notas de crédito (NCs) a facturas. Cada row representa '
  'el uso parcial o total de una NC contra una factura específica. La NC '
  'tiene saldo disponible = nc.total − SUM(aplicaciones).';

-- ─── 2) RPC ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION aplicar_nc_a_factura(
  p_nc_id      text,
  p_factura_id text,
  p_monto      numeric,
  p_fecha      date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nc           RECORD;
  v_fac          RECORD;
  v_tenant       uuid;
  v_usuario_id   integer;
  v_nc_aplicado  numeric;
  v_nc_disp      numeric;
  v_fac_pagado   numeric;
  v_fac_pendiente numeric;
  v_nuevo_pagos  jsonb;
  v_nuevo_estado_fac text;
  v_nuevo_estado_nc  text;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_fecha IS NULL THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;

  -- Lock de ambas filas para evitar race condition (dos pagos en paralelo
  -- aplicando la misma NC).
  SELECT * INTO v_nc FROM facturas WHERE id = p_nc_id FOR UPDATE;
  IF v_nc IS NULL THEN RAISE EXCEPTION 'NC_NO_ENCONTRADA'; END IF;
  IF v_nc.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NC_CROSS_TENANT'; END IF;
  IF (v_nc.tipo IS NULL OR v_nc.tipo <> 'nota_credito') THEN RAISE EXCEPTION 'NC_TIPO_INVALIDO'; END IF;
  IF v_nc.estado = 'anulada' THEN RAISE EXCEPTION 'NC_ANULADA'; END IF;
  IF v_nc.estado = 'pagada'  THEN RAISE EXCEPTION 'NC_YA_CONSUMIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.tenant_id <> v_tenant THEN RAISE EXCEPTION 'FACTURA_CROSS_TENANT'; END IF;
  IF (COALESCE(v_fac.tipo, 'factura') = 'nota_credito') THEN RAISE EXCEPTION 'FACTURA_TIPO_INVALIDO'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada'  THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  IF v_nc.prov_id IS DISTINCT FROM v_fac.prov_id THEN
    RAISE EXCEPTION 'NC_PROVEEDOR_DISTINTO';
  END IF;

  -- Saldo disponible de la NC: total − SUM aplicaciones existentes.
  SELECT COALESCE(SUM(monto), 0) INTO v_nc_aplicado
    FROM nc_aplicaciones WHERE nc_id = p_nc_id;
  v_nc_disp := abs(v_nc.total) - v_nc_aplicado;
  IF p_monto > v_nc_disp THEN
    RAISE EXCEPTION 'NC_SALDO_INSUFICIENTE';
  END IF;

  -- Saldo pendiente de la factura: total − SUM(pagos.monto).
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_fac_pagado
    FROM jsonb_array_elements(COALESCE(v_fac.pagos, '[]'::jsonb)) e;
  v_fac_pendiente := v_fac.total - v_fac_pagado;
  IF p_monto > v_fac_pendiente THEN
    RAISE EXCEPTION 'FACTURA_MONTO_EXCEDE_PENDIENTE';
  END IF;

  -- INSERT de la aplicación.
  INSERT INTO nc_aplicaciones (nc_id, factura_id, monto, fecha, tenant_id, usuario_id)
  VALUES (p_nc_id, p_factura_id, p_monto, p_fecha, v_tenant, v_usuario_id);

  -- Agregar al array pagos de la factura un objeto con tipo='nc' para
  -- distinguirlo de pagos en plata. La columna `cuenta` se setea como
  -- "Nota de Crédito" para legibilidad en UIs viejas que solo lean cuenta.
  v_nuevo_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'cuenta', 'Nota de Crédito',
      'monto', p_monto,
      'fecha', p_fecha,
      'tipo', 'nc',
      'nc_id', p_nc_id
    )
  );
  v_nuevo_estado_fac := CASE
    WHEN (v_fac_pagado + p_monto) >= v_fac.total THEN 'pagada'
    ELSE v_fac.estado
  END;
  UPDATE facturas
     SET pagos = v_nuevo_pagos, estado = v_nuevo_estado_fac
   WHERE id = p_factura_id;

  -- Si la NC quedó con saldo 0 → marcarla como consumida (estado='pagada').
  v_nuevo_estado_nc := CASE
    WHEN (v_nc_aplicado + p_monto) >= abs(v_nc.total) THEN 'pagada'
    ELSE v_nc.estado
  END;
  IF v_nuevo_estado_nc <> v_nc.estado THEN
    UPDATE facturas SET estado = v_nuevo_estado_nc WHERE id = p_nc_id;
  END IF;

  -- NO se crea movimiento en `movimientos` — la aplicación de NC no es flujo
  -- de plata real, solo compensación contable entre proveedor y cliente.

  PERFORM _auditar('facturas', 'APLICAR_NC', jsonb_build_object(
    'nc_id', p_nc_id, 'factura_id', p_factura_id, 'monto', p_monto,
    'usuario_id', v_usuario_id,
    'nc_estado_nuevo', v_nuevo_estado_nc, 'fac_estado_nuevo', v_nuevo_estado_fac
  ), v_tenant);

  RETURN jsonb_build_object(
    'nc_id', p_nc_id,
    'factura_id', p_factura_id,
    'monto', p_monto,
    'nc_estado', v_nuevo_estado_nc,
    'fac_estado', v_nuevo_estado_fac,
    'nc_saldo_restante', v_nc_disp - p_monto,
    'fac_saldo_pendiente', v_fac_pendiente - p_monto
  );
END;
$$;

GRANT EXECUTE ON FUNCTION aplicar_nc_a_factura(text, text, numeric, date) TO authenticated;
