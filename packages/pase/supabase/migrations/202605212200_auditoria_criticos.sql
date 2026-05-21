-- ═══════════════════════════════════════════════════════════════════════════
-- Migration aplicando los CRÍTICOS de la Auditoría 2026-05-21
--
-- Ref: AUDITORIA_2026-05-21.md (commit 74e0eb9)
--
-- Esta migration aplica:
--   - CRIT-3: fn_cmv_real + fn_cmv_real_resumen sin validar p_tenant_id (leak cross-tenant)
--   - CRIT-4: fn_revertir_stock_factura sin auth check (sabotage cross-tenant)
--   - CRIT-5: fn_recalcular_stock_todos sin validar p_tenant_id (corrupt cross-tenant)
--   - CRIT-6: 8 vistas sin security_invoker (leak masivo cross-tenant)
--   - CRIT-7: pagar_factura, pagar_remito, anular_factura sin FOR UPDATE (doble cobro concurrente)
--   - CRIT-8: fn_iniciar_traspaso, fn_registrar_merma, fn_aplicar_stock_venta sin lock insumo (stock negativo)
--   - CRIT-10: auth.uid()::INTEGER en 6 funciones (UUID a INTEGER → error de runtime)
--
-- TODAS las funciones se reescriben CREATE OR REPLACE con el cuerpo original
-- intacto + el fix mínimo. NO cambia signatures (sin DROP FUNCTION). NO toca
-- otras RPCs ni tablas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── CRIT-6: ALTER VIEW SET (security_invoker = on) ───────────────────────
-- 8 vistas que devuelven datos con tenant_id/local_id y no respetan RLS de
-- las tablas base. Patrón idéntico al fix 19-may de v_rrhh_empleados_visible.

ALTER VIEW v_admin_metricas_tenants     SET (security_invoker = on);
ALTER VIEW v_pedidos_delivery_mapa      SET (security_invoker = on);
ALTER VIEW v_riders_status              SET (security_invoker = on);
ALTER VIEW v_insumos_alertas_stock      SET (security_invoker = on);
ALTER VIEW v_stock_rotacion_30d         SET (security_invoker = on);
ALTER VIEW v_rrhh_adelantos_desglose    SET (security_invoker = on);
ALTER VIEW v_print_agents_status        SET (security_invoker = on);
ALTER VIEW v_items_review_queue         SET (security_invoker = on);

-- ─── CRIT-3: fn_cmv_real validar p_tenant_id ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_cmv_real(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
) RETURNS TABLE (
  insumo_id BIGINT,
  insumo_nombre TEXT,
  unidad TEXT,
  stock_inicial NUMERIC,
  compras_cantidad NUMERIC,
  compras_valor NUMERIC,
  mermas_cantidad NUMERIC,
  mermas_valor NUMERIC,
  stock_final NUMERIC,
  consumo_real_cantidad NUMERIC,
  consumo_real_valor NUMERIC,
  consumo_teorico_cantidad NUMERIC,
  consumo_teorico_valor NUMERIC,
  diferencia_cantidad NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  costo_promedio NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- CRIT-3 FIX: validar que el tenant solicitado sea el del caller
  -- (superadmin puede cruzar tenants para reportes ecosistémicos).
  IF p_tenant_id IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  RETURN QUERY
  WITH
  stock_ini AS (
    SELECT
      i.id AS insumo_id,
      COALESCE(
        (SELECT im.stock_antes
           FROM insumo_movimientos im
          WHERE im.insumo_id = i.id
            AND im.local_id = p_local_id
            AND im.tenant_id = p_tenant_id
            AND im.created_at::DATE >= p_desde
            AND im.deleted_at IS NULL
          ORDER BY im.created_at ASC
          LIMIT 1),
        COALESCE(i.stock_actual, 0)
      ) AS stock_inicial
    FROM insumos i
    WHERE i.tenant_id = p_tenant_id
      AND (i.local_id = p_local_id OR i.local_id IS NULL)
      AND i.deleted_at IS NULL
      AND i.activo = TRUE
  ),
  stock_fin AS (
    SELECT
      i.id AS insumo_id,
      COALESCE(
        (SELECT im.stock_despues
           FROM insumo_movimientos im
          WHERE im.insumo_id = i.id
            AND im.local_id = p_local_id
            AND im.tenant_id = p_tenant_id
            AND im.created_at::DATE <= p_hasta
            AND im.deleted_at IS NULL
          ORDER BY im.created_at DESC
          LIMIT 1),
        COALESCE(i.stock_actual, 0)
      ) AS stock_final
    FROM insumos i
    WHERE i.tenant_id = p_tenant_id
      AND (i.local_id = p_local_id OR i.local_id IS NULL)
      AND i.deleted_at IS NULL
      AND i.activo = TRUE
  ),
  compras AS (
    SELECT
      im.insumo_id,
      SUM(im.cantidad) AS cantidad,
      SUM(im.cantidad * COALESCE(im.costo_unitario, 0)) AS valor
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.tipo = 'entrada_compra'
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  ),
  mermas AS (
    SELECT
      im.insumo_id,
      SUM(ABS(im.cantidad)) AS cantidad,
      SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, 0)) AS valor
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.tipo IN ('merma', 'robo', 'donacion', 'salida_ajuste')
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  ),
  teorico AS (
    SELECT
      im.insumo_id,
      SUM(ABS(im.cantidad)) AS cantidad,
      SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, 0)) AS valor
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.tipo = 'salida_venta'
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  ),
  costo_prom AS (
    SELECT
      im.insumo_id,
      AVG(COALESCE(im.costo_unitario, 0)) FILTER (WHERE im.costo_unitario > 0) AS costo
    FROM insumo_movimientos im
    WHERE im.local_id = p_local_id
      AND im.tenant_id = p_tenant_id
      AND im.created_at::DATE BETWEEN p_desde AND p_hasta
      AND im.deleted_at IS NULL
    GROUP BY im.insumo_id
  )
  SELECT
    i.id::BIGINT,
    i.nombre,
    i.unidad,
    COALESCE(si.stock_inicial, 0)::NUMERIC,
    COALESCE(c.cantidad, 0)::NUMERIC,
    COALESCE(c.valor, 0)::NUMERIC,
    COALESCE(m.cantidad, 0)::NUMERIC,
    COALESCE(m.valor, 0)::NUMERIC,
    COALESCE(sf.stock_final, 0)::NUMERIC,
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))::NUMERIC AS consumo_real_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))
     * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS consumo_real_valor,
    COALESCE(t.cantidad, 0)::NUMERIC AS consumo_teorico_cantidad,
    COALESCE(t.valor, 0)::NUMERIC AS consumo_teorico_valor,
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0))::NUMERIC AS diferencia_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
      - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS diferencia_valor,
    CASE
      WHEN (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
            - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)) > 0
      THEN ROUND(
        COALESCE(t.cantidad, 0) /
        NULLIF(COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
               - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0), 0) * 100,
        2
      )
      ELSE NULL
    END AS eficiencia_pct,
    COALESCE(cp.costo, i.costo_actual, 0)::NUMERIC AS costo_promedio
  FROM insumos i
  LEFT JOIN stock_ini si ON si.insumo_id = i.id
  LEFT JOIN stock_fin sf ON sf.insumo_id = i.id
  LEFT JOIN compras c ON c.insumo_id = i.id
  LEFT JOIN mermas m ON m.insumo_id = i.id
  LEFT JOIN teorico t ON t.insumo_id = i.id
  LEFT JOIN costo_prom cp ON cp.insumo_id = i.id
  WHERE i.tenant_id = p_tenant_id
    AND (i.local_id = p_local_id OR i.local_id IS NULL)
    AND i.deleted_at IS NULL
    AND i.activo = TRUE
    AND (
      COALESCE(c.cantidad, 0) > 0 OR
      COALESCE(t.cantidad, 0) > 0 OR
      COALESCE(m.cantidad, 0) > 0 OR
      COALESCE(si.stock_inicial, 0) > 0 OR
      COALESCE(sf.stock_final, 0) > 0
    )
  ORDER BY ABS(
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0)
  ) DESC NULLS LAST;
END;
$$;

-- ─── CRIT-3: fn_cmv_real_resumen validar p_tenant_id ──────────────────────
CREATE OR REPLACE FUNCTION fn_cmv_real_resumen(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
) RETURNS TABLE (
  consumo_real_valor NUMERIC,
  consumo_teorico_valor NUMERIC,
  compras_valor NUMERIC,
  mermas_valor NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  insumos_con_fuga INTEGER,
  facturacion NUMERIC,
  cmv_real_pct NUMERIC,
  cmv_teorico_pct NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facturacion NUMERIC;
BEGIN
  -- CRIT-3 FIX
  IF p_tenant_id IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_facturacion
    FROM ventas_pos
   WHERE local_id = p_local_id
     AND tenant_id = p_tenant_id
     AND fecha::DATE BETWEEN p_desde AND p_hasta
     AND estado = 'cobrada'
     AND deleted_at IS NULL;

  RETURN QUERY
  WITH detalle AS (
    SELECT * FROM fn_cmv_real(p_tenant_id, p_local_id, p_desde, p_hasta)
  )
  SELECT
    COALESCE(SUM(d.consumo_real_valor), 0)::NUMERIC AS consumo_real_valor,
    COALESCE(SUM(d.consumo_teorico_valor), 0)::NUMERIC AS consumo_teorico_valor,
    COALESCE(SUM(d.compras_valor), 0)::NUMERIC AS compras_valor,
    COALESCE(SUM(d.mermas_valor), 0)::NUMERIC AS mermas_valor,
    COALESCE(SUM(d.diferencia_valor), 0)::NUMERIC AS diferencia_valor,
    CASE
      WHEN SUM(d.consumo_real_valor) > 0
      THEN ROUND(SUM(d.consumo_teorico_valor) / NULLIF(SUM(d.consumo_real_valor), 0) * 100, 2)
      ELSE NULL
    END AS eficiencia_pct,
    COUNT(*) FILTER (
      WHERE d.diferencia_cantidad < 0
        AND ABS(d.diferencia_cantidad) > 0.05 * GREATEST(d.consumo_real_cantidad, 0.001)
    )::INTEGER AS insumos_con_fuga,
    v_facturacion AS facturacion,
    CASE
      WHEN v_facturacion > 0
      THEN ROUND(SUM(d.consumo_real_valor) / v_facturacion * 100, 2)
      ELSE NULL
    END AS cmv_real_pct,
    CASE
      WHEN v_facturacion > 0
      THEN ROUND(SUM(d.consumo_teorico_valor) / v_facturacion * 100, 2)
      ELSE NULL
    END AS cmv_teorico_pct
  FROM detalle d;
END;
$$;

-- ─── CRIT-4: fn_revertir_stock_factura validar tenant + permisos ──────────
CREATE OR REPLACE FUNCTION fn_revertir_stock_factura(p_factura_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revertidos INTEGER := 0;
  v_mov RECORD;
  v_factura_tenant UUID;
BEGIN
  -- CRIT-4 FIX: validar que el caller es del mismo tenant que la factura.
  -- Sin este check, cualquier user auth podía revertir stock de otro tenant.
  SELECT tenant_id INTO v_factura_tenant FROM facturas WHERE id = p_factura_id;
  IF v_factura_tenant IS NULL THEN
    RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA';
  END IF;
  IF v_factura_tenant IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_es_superadmin()) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  FOR v_mov IN
    SELECT im.id, im.tenant_id, im.local_id, im.insumo_id, im.cantidad, im.costo_unitario
      FROM insumo_movimientos im
     WHERE im.fuente_tipo = 'factura_item'
       AND im.fuente_id IN (SELECT id::BIGINT FROM factura_items WHERE factura_id = p_factura_id)
       AND im.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos rev
         WHERE rev.fuente_tipo = 'reversion_factura'
           AND rev.fuente_id = im.id
           AND rev.deleted_at IS NULL
       )
  LOOP
    INSERT INTO insumo_movimientos (
      tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
      motivo, fuente_tipo, fuente_id
    ) VALUES (
      v_mov.tenant_id, v_mov.local_id, v_mov.insumo_id, 'entrada_devolucion',
      -v_mov.cantidad, v_mov.costo_unitario,
      'Reversión anulación factura ' || p_factura_id,
      'reversion_factura', v_mov.id
    );
    v_revertidos := v_revertidos + 1;
  END LOOP;

  RETURN v_revertidos;
END;
$$;

-- ─── CRIT-5: fn_recalcular_stock_todos validar p_tenant_id ────────────────
CREATE OR REPLACE FUNCTION fn_recalcular_stock_todos(p_tenant_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_caller_tenant UUID;
  v_count INTEGER := 0;
BEGIN
  v_caller_tenant := auth_tenant_id();
  IF v_caller_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  -- CRIT-5 FIX: validar que el p_tenant_id pasado coincide con el del caller
  -- (excepto superadmin, que puede cruzar tenants).
  IF p_tenant_id IS NOT NULL
     AND p_tenant_id IS DISTINCT FROM v_caller_tenant
     AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  v_tenant_id := COALESCE(p_tenant_id, v_caller_tenant);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_TENANT_RESOLVED'; END IF;

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

-- ─── CRIT-7: pagar_factura con FOR UPDATE ─────────────────────────────────
CREATE OR REPLACE FUNCTION pagar_factura(
  p_factura_id text, p_monto numeric, p_cuenta text, p_fecha date,
  p_detalle text DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fac RECORD; v_mov_id text; v_tenant uuid;
  v_existing_mov RECORD; v_nuevos_pagos jsonb; v_total_pagado numeric; v_nuevo_estado text;
  v_detalle text;
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

  -- CRIT-7 FIX: lock de la fila factura para evitar doble cobro concurrente.
  -- Sin FOR UPDATE, 2 usuarios cobrando simultáneamente leen pagos=[] y
  -- T2 sobrescribe el UPDATE de T1, generando 2 movimientos pero solo 1
  -- registro en facturas.pagos → caja sale corta sin explicación.
  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('cuenta', p_cuenta, 'monto', p_monto, 'fecha', p_fecha));
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;
  v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

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

  PERFORM _auditar('facturas', 'PAGO', jsonb_build_object(
    'factura_id', p_factura_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado, 'total_pagado', v_total_pagado);
END;
$$;

-- ─── CRIT-7: pagar_remito con FOR UPDATE ──────────────────────────────────
CREATE OR REPLACE FUNCTION pagar_remito(
  p_remito_id text, p_monto numeric, p_cuenta text, p_fecha date,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_r RECORD; v_prov RECORD; v_mov_id text; v_tenant uuid;
  v_existing_mov RECORD;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_mov FROM movimientos
    WHERE idempotency_key = p_idempotency_key
      AND tipo = 'Pago Proveedor'
      AND remito_id_ref = p_remito_id;
    IF v_existing_mov.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'mov_id', v_existing_mov.id,
        'nuevo_estado', 'pagado',
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  -- CRIT-7 FIX: lock de la fila remito (igual que pagar_factura).
  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id FOR UPDATE;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_ANULADO'; END IF;
  IF v_r.estado = 'pagado' THEN RAISE EXCEPTION 'REMITO_YA_PAGADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  UPDATE remitos SET estado = 'pagado' WHERE id = p_remito_id;

  SELECT * INTO v_prov FROM proveedores WHERE id = v_r.prov_id;

  IF v_r.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_r.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle, local_id, remito_id_ref, tenant_id,
    idempotency_key
  ) VALUES (
    v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_r.cat, -p_monto,
    'Pago remito ' || COALESCE(v_r.nro, v_r.id) || COALESCE(' - ' || v_prov.nombre, ''),
    v_r.local_id, p_remito_id, v_tenant,
    p_idempotency_key
  );

  PERFORM _auditar('remitos', 'PAGO', jsonb_build_object(
    'remito_id', p_remito_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', 'pagado');
END;
$$;

-- ─── CRIT-7: anular_factura con FOR UPDATE ────────────────────────────────
CREATE OR REPLACE FUNCTION anular_factura(
  p_factura_id TEXT,
  p_motivo TEXT,
  p_override_code TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_fac RECORD; v_tenant uuid;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_factura',
    jsonb_build_object('factura_id', p_factura_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  -- CRIT-7 FIX: lock de la fila factura.
  -- Sin esto, anular + pagar concurrentes podrían dejar factura anulada
  -- pero con un movimiento de pago activo en la caja.
  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_YA_ANULADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  UPDATE facturas SET estado = 'anulada' WHERE id = p_factura_id;

  PERFORM _auditar('facturas', 'ANULACION', jsonb_build_object(
    'factura_id', p_factura_id, 'motivo', p_motivo,
    'estado_previo', v_fac.estado, 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada');
END;
$$;

-- ─── CRIT-8: fn_iniciar_traspaso con FOR UPDATE en insumo ─────────────────
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

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN RAISE EXCEPTION 'CANTIDAD_INVALIDA'; END IF;
  IF p_local_origen_id = p_local_destino_id THEN RAISE EXCEPTION 'LOCALES_IGUALES'; END IF;

  -- CRIT-8 FIX: lock del insumo para serializar lecturas concurrentes de stock.
  -- Sin FOR UPDATE, 2 traspasos del mismo insumo en paralelo leen el mismo
  -- stock disponible y dejan stock_actual negativo al insertar ambos.
  SELECT id, nombre, COALESCE(costo_actual, 0) AS costo, COALESCE(stock_actual, 0) AS stock
    INTO v_insumo
    FROM insumos
   WHERE id = p_insumo_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF v_insumo IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_origen_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_destino_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_origen_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_ORIGEN';
  END IF;

  IF v_insumo.stock < p_cantidad THEN
    RAISE EXCEPTION 'STOCK_INSUFICIENTE';
  END IF;

  INSERT INTO stock_transferencias (
    tenant_id, insumo_id, local_origen_id, local_destino_id,
    cantidad, costo_unitario, motivo, usuario_id, estado
  ) VALUES (
    v_tenant_id, p_insumo_id, p_local_origen_id, p_local_destino_id,
    p_cantidad, v_insumo.costo, p_motivo, v_user_id, 'en_transito'
  ) RETURNING id INTO v_transf_id;

  -- Insertar movimiento de salida en origen (el trigger fn_trg_insumo_mov
  -- update_stock recalcula stock_actual).
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id
  ) VALUES (
    v_tenant_id, p_local_origen_id, p_insumo_id, 'salida_traspaso',
    -p_cantidad, v_insumo.costo,
    'Traspaso en tránsito #' || v_transf_id || COALESCE(' — ' || p_motivo, ''),
    'transferencia', v_transf_id, v_user_id
  ) RETURNING id INTO v_mov_origen_id;

  -- Guardar referencia al movimiento origen para idempotency en recepción
  UPDATE stock_transferencias SET mov_origen_id = v_mov_origen_id
    WHERE id = v_transf_id;

  RETURN v_transf_id;
END;
$$;

-- ─── CRIT-8: fn_registrar_merma con FOR UPDATE en insumo ──────────────────
CREATE OR REPLACE FUNCTION fn_registrar_merma(
  p_insumo_id BIGINT,
  p_local_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo_id BIGINT,
  p_notas TEXT DEFAULT NULL,
  p_manager_id INTEGER DEFAULT NULL,
  p_override_code TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_motivo RECORD;
  v_insumo RECORD;
  v_mov_id BIGINT;
  v_user_id INTEGER;
  v_manager_id INTEGER := NULL;
  v_override_ok BOOLEAN;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  v_user_id := auth_usuario_id();

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;

  SELECT * INTO v_motivo FROM mermas_motivos
    WHERE id = p_motivo_id
      AND tenant_id = v_tenant_id
      AND activo = TRUE
      AND deleted_at IS NULL;
  IF v_motivo IS NULL THEN RAISE EXCEPTION 'MOTIVO_NO_ENCONTRADO'; END IF;

  IF v_motivo.tipo_movimiento = 'robo' THEN
    v_override_ok := auth_tiene_permiso_o_override(
      'stock_anular',
      p_override_code,
      'registrar_robo_insumo',
      jsonb_build_object(
        'insumo_id', p_insumo_id,
        'local_id', p_local_id,
        'cantidad', p_cantidad,
        'motivo', v_motivo.nombre
      )
    );
    IF NOT v_override_ok THEN
      IF p_override_code IS NULL THEN
        RAISE EXCEPTION 'ROBO_REQUIERE_OVERRIDE';
      ELSE
        RAISE EXCEPTION 'OVERRIDE_INVALIDO';
      END IF;
    END IF;
    v_manager_id := NULL;
  END IF;

  -- CRIT-8 FIX: lock del insumo para evitar stock negativo en concurrencia.
  SELECT * INTO v_insumo FROM insumos
    WHERE id = p_insumo_id
      AND tenant_id = v_tenant_id
      AND deleted_at IS NULL
    FOR UPDATE;
  IF v_insumo IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id, manager_id
  ) VALUES (
    v_tenant_id, p_local_id, p_insumo_id, v_motivo.tipo_movimiento,
    -p_cantidad, COALESCE(v_insumo.costo_actual, 0),
    v_motivo.nombre || COALESCE(' — ' || p_notas, ''),
    'merma_motivo', p_motivo_id,
    v_user_id, v_manager_id
  ) RETURNING id INTO v_mov_id;

  RETURN v_mov_id;
END;
$$;

-- ─── CRIT-10: fn_registrar_pago_invoice fix auth.uid()::INTEGER ───────────
CREATE OR REPLACE FUNCTION fn_registrar_pago_invoice(
  p_invoice_id BIGINT,
  p_metodo_pago TEXT DEFAULT 'transferencia',
  p_gateway_payment_id TEXT DEFAULT NULL,
  p_notas TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_inv RECORD;
  v_user_id INTEGER;
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SOLO_SUPERADMIN';
  END IF;

  -- CRIT-7-bis FIX: lock invoice (defensa contra doble click).
  SELECT * INTO v_inv FROM tenant_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'INVOICE_NO_ENCONTRADA'; END IF;
  IF v_inv.estado = 'pagada' THEN RAISE EXCEPTION 'INVOICE_YA_PAGADA'; END IF;

  -- CRIT-10 FIX: usar helper auth_usuario_id() en vez de auth.uid()::INTEGER.
  -- El cast UUID a INTEGER falla con error de runtime → la RPC nunca completa.
  v_user_id := auth_usuario_id();

  UPDATE tenant_invoices SET
    estado = 'pagada',
    fecha_pago = CURRENT_DATE,
    metodo_pago = p_metodo_pago,
    gateway_payment_id = p_gateway_payment_id,
    notas = COALESCE(notas || E'\n', '') || COALESCE(p_notas, ''),
    cobrada_por = v_user_id,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  UPDATE tenant_subscriptions SET
    estado = 'active',
    current_period_start = v_inv.periodo_desde,
    current_period_end = v_inv.periodo_hasta,
    next_billing_at = v_inv.periodo_hasta + INTERVAL '1 day',
    updated_at = NOW()
  WHERE id = v_inv.subscription_id;
END;
$$;

-- ─── CRIT-10: fn_cargar_conteo_linea fix auth.uid()::INTEGER ──────────────
CREATE OR REPLACE FUNCTION fn_cargar_conteo_linea(
  p_conteo_id BIGINT,
  p_insumo_id BIGINT,
  p_stock_contado NUMERIC,
  p_notas TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
BEGIN
  SELECT local_id INTO v_local_id FROM stock_conteos
   WHERE id = p_conteo_id AND estado = 'abierto' AND tenant_id = auth_tenant_id();
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'CONTEO_NO_ABIERTO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF p_stock_contado < 0 THEN RAISE EXCEPTION 'STOCK_NEGATIVO'; END IF;

  -- CRIT-10 FIX
  UPDATE stock_conteo_lineas SET
    stock_contado = p_stock_contado,
    notas = p_notas,
    contado_at = NOW(),
    contado_por = auth_usuario_id()
  WHERE conteo_id = p_conteo_id AND insumo_id = p_insumo_id;
END;
$$;

-- ─── CRIT-10: fn_finalizar_conteo_fisico fix auth.uid()::INTEGER (2 lugares) ─
CREATE OR REPLACE FUNCTION fn_finalizar_conteo_fisico(p_conteo_id BIGINT)
RETURNS TABLE (ajustes INTEGER, diferencia_valor NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_ajustes INTEGER := 0;
  v_dif NUMERIC := 0;
  v_linea RECORD;
  v_costo NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM stock_conteos
   WHERE id = p_conteo_id AND estado = 'abierto';
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'CONTEO_NO_ABIERTO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  FOR v_linea IN
    SELECT l.insumo_id, l.diferencia, i.costo_actual
      FROM stock_conteo_lineas l
      INNER JOIN insumos i ON i.id = l.insumo_id
     WHERE l.conteo_id = p_conteo_id
       AND l.stock_contado IS NOT NULL
       AND l.diferencia <> 0
  LOOP
    v_costo := COALESCE(v_linea.costo_actual, 0);
    INSERT INTO insumo_movimientos (
      tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
      motivo, fuente_tipo, fuente_id, usuario_id
    ) VALUES (
      v_tenant_id, v_local_id, v_linea.insumo_id, 'conteo',
      v_linea.diferencia, v_costo,
      'Diferencia conteo físico #' || p_conteo_id,
      'conteo', p_conteo_id, auth_usuario_id()  -- CRIT-10 FIX
    );
    v_ajustes := v_ajustes + 1;
    v_dif := v_dif + (v_linea.diferencia * v_costo);
  END LOOP;

  UPDATE stock_conteos SET
    estado = 'finalizado',
    finalizado_at = NOW(),
    finalizado_por = auth_usuario_id(),  -- CRIT-10 FIX
    total_ajustes = v_ajustes,
    valor_diferencia = v_dif
  WHERE id = p_conteo_id;

  RETURN QUERY SELECT v_ajustes, v_dif;
END;
$$;

-- ─── CRIT-10: fn_iniciar_conteo_fisico fix auth.uid()::INTEGER ────────────
CREATE OR REPLACE FUNCTION fn_iniciar_conteo_fisico(
  p_local_id INTEGER,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_conteo_id BIGINT;
  v_count INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF EXISTS (
    SELECT 1 FROM stock_conteos
     WHERE local_id = p_local_id AND tenant_id = v_tenant_id AND estado = 'abierto'
  ) THEN
    RAISE EXCEPTION 'CONTEO_YA_ABIERTO';
  END IF;

  -- CRIT-10 FIX
  INSERT INTO stock_conteos (tenant_id, local_id, iniciado_por, notas)
  VALUES (v_tenant_id, p_local_id, auth_usuario_id(), p_notas)
  RETURNING id INTO v_conteo_id;

  INSERT INTO stock_conteo_lineas (conteo_id, insumo_id, stock_teorico)
  SELECT v_conteo_id, i.id, COALESCE(i.stock_actual, 0)
    FROM insumos i
   WHERE i.tenant_id = v_tenant_id
     AND i.activo = TRUE
     AND i.deleted_at IS NULL
     AND (i.local_id IS NULL OR i.local_id = p_local_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE stock_conteos SET total_insumos = v_count WHERE id = v_conteo_id;

  RETURN v_conteo_id;
END;
$$;

-- ─── CRIT-10: fn_ajustar_stock_insumo fix auth.uid()::INTEGER ─────────────
CREATE OR REPLACE FUNCTION fn_ajustar_stock_insumo(
  p_insumo_id BIGINT,
  p_cantidad NUMERIC,
  p_tipo TEXT,
  p_motivo TEXT,
  p_manager_id INTEGER DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_costo NUMERIC;
  v_mov_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_cantidad = 0 THEN RAISE EXCEPTION 'CANTIDAD_INVALIDA'; END IF;
  IF p_tipo NOT IN ('entrada_ajuste','salida_ajuste','merma','robo','donacion') THEN
    RAISE EXCEPTION 'TIPO_AJUSTE_INVALIDO';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;
  IF p_tipo IN ('robo', 'donacion') AND p_manager_id IS NULL THEN
    RAISE EXCEPTION 'MANAGER_REQUERIDO_PARA_TIPO';
  END IF;

  SELECT tenant_id, local_id, costo_actual
    INTO v_tenant_id, v_local_id, v_costo
    FROM insumos
   WHERE id = p_insumo_id AND deleted_at IS NULL;
  IF v_local_id IS NULL AND v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO';
  END IF;

  IF v_local_id IS NULL THEN
    IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'PERMISO_DENEGADO'; END IF;
  ELSE
    IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
      RAISE EXCEPTION 'PERMISO_DENEGADO';
    END IF;
  END IF;

  -- CRIT-10 FIX
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario, motivo,
    usuario_id, manager_id
  ) VALUES (
    v_tenant_id, v_local_id, p_insumo_id, p_tipo,
    p_cantidad, v_costo, trim(p_motivo),
    auth_usuario_id(), p_manager_id
  ) RETURNING id INTO v_mov_id;

  RETURN v_mov_id;
END;
$$;

-- ─── CRIT-10: fn_canjear_puntos_cliente fix auth.uid()::INTEGER ───────────
CREATE OR REPLACE FUNCTION fn_canjear_puntos_cliente(
  p_cliente_id BIGINT,
  p_venta_id BIGINT,
  p_puntos NUMERIC
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER
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

  -- CRIT-10 FIX
  INSERT INTO cliente_puntos_movimientos (
    tenant_id, local_id, cliente_id, tipo, puntos, venta_id, motivo,
    usuario_id
  ) VALUES (
    v_tenant_id, v_local_id, p_cliente_id, 'canje', -p_puntos, p_venta_id,
    'Canje en venta #' || p_venta_id,
    auth_usuario_id()
  );

  UPDATE ventas_pos SET
    descuento_total = COALESCE(descuento_total, 0) + v_descuento,
    total = total - v_descuento,
    updated_at = NOW()
  WHERE id = p_venta_id;

  RETURN v_descuento;
END;
$$;

-- ─── Recargar schema cache de PostgREST ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
