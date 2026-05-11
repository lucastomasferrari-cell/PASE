-- ═══════════════════════════════════════════════════════════════════════════
-- MP — conciliación multi-factura + ignorar (commit Lucas 2026-05-11).
--
-- Dos features pedidas por Lucas:
--
-- 1) Multi-factura: el caso real (frecuente) es un pago MP que cubre N
--    facturas del mismo proveedor. El schema anterior es 1:1 — un mp_mov
--    se linkea a un solo justificativo_id. Esta migration agrega:
--      - Tipo nuevo 'multi_factura' en el CHECK de justificativo_tipo.
--      - Tabla puente mp_movimiento_facturas (mp_mov_id × factura_id ×
--        monto_aplicado). La suma aplicada PUEDE diferir del monto MP
--        (Lucas pidió que no se bloquee ni cuando sobra ni cuando falta).
--      - RPC fn_conciliar_mp_con_facturas(p_mp_mov_id, p_lineas[],
--        p_idempotency_key) — atómica.
--
--    Trade-off contable consciente: cuando suma_aplicada ≠ monto_mp,
--    saldos_caja se decrementa por monto_mp completo (la plata salió de
--    MP de verdad) pero proveedores.saldo se decrementa por suma_aplicada
--    (solo eso se le imputó). La diferencia queda visible en la UI.
--
-- 2) Ignorar: a veces hay egresos que no se quiere conciliar pero tampoco
--    contar como "sin justificar" (reverso de prueba, duplicado en banco,
--    etc.). Esta migration agrega columnas ignorado/motivo/at/por + RPCs
--    fn_ignorar_mp y fn_designorar_mp (reversible). El KPI del header
--    excluye ignorados.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1) Extender el CHECK de justificativo_tipo ────────────────────────────
ALTER TABLE mp_movimientos
  DROP CONSTRAINT IF EXISTS mp_movimientos_justificativo_tipo_check;
ALTER TABLE mp_movimientos
  ADD CONSTRAINT mp_movimientos_justificativo_tipo_check
  CHECK (justificativo_tipo IS NULL OR justificativo_tipo IN (
    'factura', 'remito', 'gasto', 'egreso_manual',
    'movimiento_interno', 'comision_mp', 'retiro_automatico',
    'multi_factura'
  ));

-- Extender el id_check: multi_factura NO usa justificativo_id (las
-- facturas viven en la tabla puente).
ALTER TABLE mp_movimientos
  DROP CONSTRAINT IF EXISTS mp_movimientos_justificativo_id_check;
ALTER TABLE mp_movimientos
  ADD CONSTRAINT mp_movimientos_justificativo_id_check
  CHECK (
    justificativo_tipo IS NULL
    OR justificativo_tipo IN ('comision_mp', 'retiro_automatico', 'multi_factura')
    OR justificativo_id IS NOT NULL
  );

-- ─── 2) Columnas de "ignorado" ─────────────────────────────────────────────
ALTER TABLE mp_movimientos
  ADD COLUMN IF NOT EXISTS ignorado        boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ignorado_motivo text         NULL,
  ADD COLUMN IF NOT EXISTS ignorado_at     timestamptz  NULL,
  ADD COLUMN IF NOT EXISTS ignorado_por    integer      NULL REFERENCES usuarios(id);

COMMENT ON COLUMN mp_movimientos.ignorado IS
  'Marcado a propósito como "no requiere conciliación" (ej: reverso de prueba, '
  'duplicado de banco). Excluido del KPI "sin justificar". Reversible vía '
  'fn_designorar_mp.';
COMMENT ON COLUMN mp_movimientos.ignorado_motivo IS
  'Texto libre opcional (ej: "duplicado", "prueba"). Para rastro auditable.';

-- ─── 3) Actualizar index "sin justificar" para excluir ignorados ───────────
DROP INDEX IF EXISTS idx_mp_mov_sin_justificar;
CREATE INDEX idx_mp_mov_sin_justificar
  ON mp_movimientos (fecha DESC, local_id)
  WHERE monto < 0 AND anulado = false AND justificativo_tipo IS NULL AND ignorado = false;

-- ─── 4) Tabla puente mp_movimiento_facturas ────────────────────────────────
-- Relación N:1 (varias facturas linkeadas a un mismo mp_mov). Los IDs son
-- TEXT prefijados — mismo patrón que el resto del sistema.
CREATE TABLE IF NOT EXISTS mp_movimiento_facturas (
  id             BIGSERIAL PRIMARY KEY,
  mp_mov_id      TEXT      NOT NULL REFERENCES mp_movimientos(id) ON DELETE CASCADE,
  factura_id     TEXT      NOT NULL REFERENCES facturas(id)       ON DELETE RESTRICT,
  monto_aplicado NUMERIC   NOT NULL CHECK (monto_aplicado > 0),
  tenant_id      UUID      NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mp_mov_id, factura_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_mov_facturas_mp     ON mp_movimiento_facturas(mp_mov_id);
CREATE INDEX IF NOT EXISTS idx_mp_mov_facturas_fac    ON mp_movimiento_facturas(factura_id);
CREATE INDEX IF NOT EXISTS idx_mp_mov_facturas_tenant ON mp_movimiento_facturas(tenant_id);

ALTER TABLE mp_movimiento_facturas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mp_movimiento_facturas_mt ON mp_movimiento_facturas;
CREATE POLICY mp_movimiento_facturas_mt ON mp_movimiento_facturas FOR ALL TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id())
  WITH CHECK (auth_es_superadmin() OR tenant_id = auth_tenant_id());

GRANT SELECT, INSERT ON mp_movimiento_facturas TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE mp_movimiento_facturas_id_seq TO authenticated;

COMMENT ON TABLE mp_movimiento_facturas IS
  'Tabla puente para pagos MP que cubren varias facturas. monto_aplicado '
  'es lo que se imputó a esa factura específica. La SUM no necesariamente '
  'coincide con abs(monto del MP) — Lucas pidió no bloquear ni cuando '
  'sobra ni cuando falta (warning visual en UI, no error).';

-- ─── 5) RPC fn_conciliar_mp_con_facturas (multi-factura) ───────────────────
CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_facturas(
  p_mp_mov_id        text,
  p_lineas           jsonb,        -- [{ factura_id, monto_aplicado }, ...]
  p_idempotency_key  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp                RECORD;
  v_usuario_id        integer;
  v_linea             jsonb;
  v_factura_id        text;
  v_monto             numeric;
  v_fac               RECORD;
  v_proveedor_id      integer;
  v_proveedor_primero integer;
  v_nuevos_pagos      jsonb;
  v_total_pagado      numeric;
  v_nuevo_estado      text;
  v_total_aplicado    numeric := 0;
  v_facturas_pagadas  text[] := ARRAY[]::text[];
  v_mov_id            text;
  v_cached            jsonb;
  v_result            jsonb;
  v_monto_abs         numeric;
  v_fecha             date;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  IF p_lineas IS NULL OR jsonb_typeof(p_lineas) != 'array' OR jsonb_array_length(p_lineas) = 0 THEN
    RAISE EXCEPTION 'LINEAS_REQUERIDAS';
  END IF;

  -- Idempotency check (convención C1) — si ya se procesó este key, devolver
  -- resultado cacheado sin re-ejecutar.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'fn_conciliar_mp_con_facturas' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  -- Valida + bloquea el mp_mov (FOR UPDATE evita race con re-conciliación).
  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);

  -- Si el mp está ignorado, no se puede conciliar (hay que des-ignorar primero).
  IF EXISTS (SELECT 1 FROM mp_movimientos WHERE id = p_mp_mov_id AND ignorado = true) THEN
    RAISE EXCEPTION 'MP_MOV_IGNORADO';
  END IF;

  v_monto_abs := abs(v_mp.monto);
  v_fecha     := COALESCE((v_mp.fecha)::date, current_date);

  -- ── Iterar líneas: validar, agregar a tabla puente, actualizar facturas ──
  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_factura_id := nullif(trim(v_linea->>'factura_id'), '');
    v_monto      := COALESCE((v_linea->>'monto_aplicado')::numeric, 0);
    IF v_factura_id IS NULL THEN RAISE EXCEPTION 'FACTURA_ID_REQUERIDO'; END IF;
    IF v_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

    -- Bloqueo FOR UPDATE en la factura para evitar pagos paralelos.
    SELECT * INTO v_fac FROM facturas WHERE id = v_factura_id FOR UPDATE;
    IF v_fac IS NULL                       THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
    IF v_fac.tenant_id <> v_mp.tenant_id   THEN RAISE EXCEPTION 'FACTURA_CROSS_TENANT';  END IF;
    IF v_fac.estado = 'anulada'            THEN RAISE EXCEPTION 'FACTURA_ANULADA';       END IF;
    IF v_fac.estado = 'pagada'             THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA';     END IF;

    -- Todas las facturas deben ser del mismo proveedor (regla operativa
    -- confirmada por Lucas — simplifica la UX).
    v_proveedor_id := v_fac.prov_id;
    IF v_proveedor_primero IS NULL THEN
      v_proveedor_primero := v_proveedor_id;
    ELSIF v_proveedor_id IS DISTINCT FROM v_proveedor_primero THEN
      RAISE EXCEPTION 'FACTURAS_DE_PROVEEDORES_DISTINTOS';
    END IF;

    -- Append pago a facturas.pagos (mismo formato que pagar_factura)
    v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'cuenta', 'MercadoPago',
        'monto',  v_monto,
        'fecha',  v_fecha,
        'mp_mov_id', p_mp_mov_id
      )
    );
    SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
      FROM jsonb_array_elements(v_nuevos_pagos) e;
    v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

    UPDATE facturas
       SET estado = v_nuevo_estado,
           pagos  = v_nuevos_pagos
     WHERE id = v_factura_id;

    -- Tabla puente
    INSERT INTO mp_movimiento_facturas (mp_mov_id, factura_id, monto_aplicado, tenant_id)
      VALUES (p_mp_mov_id, v_factura_id, v_monto, v_mp.tenant_id);

    -- Saldo proveedor: solo se decrementa por lo que se le imputó.
    IF v_fac.prov_id IS NOT NULL THEN
      UPDATE proveedores
         SET saldo = GREATEST(0, COALESCE(saldo, 0) - v_monto)
       WHERE id = v_fac.prov_id;
    END IF;

    v_total_aplicado := v_total_aplicado + v_monto;
    IF v_nuevo_estado = 'pagada' THEN
      v_facturas_pagadas := array_append(v_facturas_pagadas, v_factura_id);
    END IF;
  END LOOP;

  -- ── Movimiento contable consolidado por el TOTAL aplicado ──────────────
  -- (no por monto_mp — porque la "sobra" no debe figurar como pago a nadie)
  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
    VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Multi-factura',
            'PAGO_PROVEEDOR', -v_total_aplicado,
            'Pago a ' || jsonb_array_length(p_lineas) || ' facturas vía MP',
            v_mp.local_id, v_mp.tenant_id, NULL);

  -- ── Saldo de caja MP: el dinero que salió de MP es el monto MP real ────
  -- (la diferencia con suma aplicada queda como "sobra/falta", visible en UI)
  PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_monto_abs);

  -- ── Marcar el mp_mov como multi_factura ────────────────────────────────
  UPDATE mp_movimientos
     SET justificativo_tipo = 'multi_factura',
         justificativo_id   = NULL,   -- las facturas viven en la puente
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_MULTI_FACTURA', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'mov_id', v_mov_id,
    'cant_facturas', jsonb_array_length(p_lineas),
    'total_aplicado', v_total_aplicado, 'monto_mp', v_monto_abs,
    'diferencia', v_monto_abs - v_total_aplicado,
    'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  v_result := jsonb_build_object(
    'mp_mov_id', p_mp_mov_id,
    'tipo', 'multi_factura',
    'mov_id', v_mov_id,
    'total_aplicado', v_total_aplicado,
    'monto_mp', v_monto_abs,
    'diferencia', v_monto_abs - v_total_aplicado,
    'facturas_pagadas', to_jsonb(v_facturas_pagadas)
  );

  -- ── Guardar idempotency record al final ────────────────────────────────
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('fn_conciliar_mp_con_facturas', p_idempotency_key, v_mp.tenant_id, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_facturas(text, jsonb, text) TO authenticated;

-- ─── 6) RPC fn_ignorar_mp ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_ignorar_mp(
  p_mp_mov_id  text,
  p_motivo     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp          RECORD;
  v_tenant      uuid;
  v_usuario_id  integer;
  v_motivo      text;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;

  SELECT id, tenant_id, anulado, justificativo_tipo, ignorado
    INTO v_mp
    FROM mp_movimientos WHERE id = p_mp_mov_id FOR UPDATE;

  IF NOT FOUND                         THEN RAISE EXCEPTION 'MP_MOV_NO_ENCONTRADO'; END IF;
  IF v_mp.tenant_id <> v_tenant        THEN RAISE EXCEPTION 'MP_MOV_CROSS_TENANT';  END IF;
  IF v_mp.anulado                      THEN RAISE EXCEPTION 'MP_MOV_ANULADO';       END IF;
  IF v_mp.justificativo_tipo IS NOT NULL THEN RAISE EXCEPTION 'MP_MOV_YA_JUSTIFICADO'; END IF;
  IF v_mp.ignorado                     THEN RAISE EXCEPTION 'MP_MOV_YA_IGNORADO';   END IF;

  v_motivo := nullif(trim(coalesce(p_motivo, '')), '');

  UPDATE mp_movimientos
     SET ignorado        = true,
         ignorado_motivo = v_motivo,
         ignorado_at     = now(),
         ignorado_por    = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'IGNORAR_MP', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'motivo', v_motivo, 'usuario_id', v_usuario_id
  ), v_tenant);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'ignorado', true);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_ignorar_mp(text, text) TO authenticated;

-- ─── 7) RPC fn_designorar_mp ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_designorar_mp(p_mp_mov_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp       RECORD;
  v_tenant   uuid;
  v_usuario_id integer;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;

  SELECT id, tenant_id, ignorado
    INTO v_mp
    FROM mp_movimientos WHERE id = p_mp_mov_id FOR UPDATE;

  IF NOT FOUND                     THEN RAISE EXCEPTION 'MP_MOV_NO_ENCONTRADO'; END IF;
  IF v_mp.tenant_id <> v_tenant    THEN RAISE EXCEPTION 'MP_MOV_CROSS_TENANT';  END IF;
  IF NOT v_mp.ignorado             THEN RAISE EXCEPTION 'MP_MOV_NO_IGNORADO';   END IF;

  UPDATE mp_movimientos
     SET ignorado        = false,
         ignorado_motivo = NULL,
         ignorado_at     = NULL,
         ignorado_por    = NULL
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'DESIGNORAR_MP', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'usuario_id', v_usuario_id
  ), v_tenant);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'ignorado', false);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_designorar_mp(text) TO authenticated;
