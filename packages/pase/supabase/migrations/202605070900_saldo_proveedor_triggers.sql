-- ═══════════════════════════════════════════════════════════════════════════
-- Triggers atómicos para proveedores.saldo
--
-- Fecha: 2026-05-07
-- Doc:   PASE_COMANDA_CONTEXTO_2026_05_06.md sección 9.2 (bug latente #1)
--
-- Problema: hasta hoy 4 lugares en frontend (Compras, LectorIA, Remitos
-- carga, Remitos vincFact) y 4 RPCs SQL (pagar_factura, pagar_remito,
-- anular_factura, anular_remito) hacían UPDATE proveedores SET saldo
-- = saldo ± delta. Sin atomicidad → race condition con cargas
-- concurrentes. Auditoría 2026-05-06 detectó $2.706.931 sobreestimados
-- en 6 proveedores.
--
-- Solución: triggers AFTER en facturas y remitos que recalculan el
-- saldo del proveedor afectado en cada evento. La columna pasa a ser
-- un cache sincronizado automáticamente.
--
-- Fuente de verdad: lib/saldoProveedor.ts (helper TS) sigue siendo el
-- cálculo runtime de las pantallas. La fórmula del trigger replica
-- ese helper 1:1 — si difiere, se pisan mutuamente y se corrompen.
--
-- Modelo simplificado respecto al prompt original: NO hay tabla de
-- pagos separada. Los pagos parciales viven en facturas.pagos JSONB,
-- y los pagos a remitos cambian su estado a 'pagado'. Por lo tanto
-- el trigger de facturas captura UPDATE pagos automáticamente y el de
-- remitos captura UPDATE estado.
--
-- Performance: HOY no hay batch inserts grandes en facturas/remitos
-- (Maxirest carga ventas, no facturas). Si en el futuro se importan
-- batches grandes, considerar deferred recalc o desactivar
-- temporalmente los triggers durante el batch.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Función de recálculo por proveedor ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_recalcular_saldo_proveedor(p_proveedor_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_saldo NUMERIC;
BEGIN
  IF p_proveedor_id IS NULL THEN RETURN; END IF;

  -- Fórmula 1:1 con lib/saldoProveedor.ts:
  --   Facturas activas (estado != 'anulada','pagada'):
  --     · tipo='nota_credito' → -ABS(total)
  --     · resto              → MAX(0, total - SUM(pagos JSONB))
  --   Remitos sin factura (factura_id IS NULL AND estado='sin_factura'):
  --     · suma monto
  SELECT
    COALESCE((
      SELECT SUM(CASE
        WHEN f.tipo = 'nota_credito' THEN -ABS(COALESCE(f.total, 0))
        ELSE GREATEST(0, COALESCE(f.total, 0) - COALESCE((
          SELECT SUM((p->>'monto')::numeric)
          FROM jsonb_array_elements(COALESCE(f.pagos, '[]'::jsonb)) p
        ), 0))
      END)
      FROM facturas f
      WHERE f.prov_id = p_proveedor_id
        AND f.estado NOT IN ('anulada', 'pagada')
    ), 0)
    +
    COALESCE((
      SELECT SUM(COALESCE(r.monto, 0))
      FROM remitos r
      WHERE r.prov_id = p_proveedor_id
        AND r.estado = 'sin_factura'
        AND r.factura_id IS NULL
    ), 0)
  INTO v_saldo;

  UPDATE proveedores SET saldo = v_saldo WHERE id = p_proveedor_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_recalcular_saldo_proveedor(INTEGER) FROM PUBLIC;

-- ─── Trigger function ────────────────────────────────────────────────────
-- En INSERT/DELETE: recalcula NEW (o OLD si DELETE) prov_id.
-- En UPDATE: recalcula NEW.prov_id; si OLD.prov_id distinto (raro pero
-- contemplado), también recalcula OLD.prov_id.
CREATE OR REPLACE FUNCTION trg_saldo_proveedor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM fn_recalcular_saldo_proveedor(NEW.prov_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM fn_recalcular_saldo_proveedor(OLD.prov_id);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM fn_recalcular_saldo_proveedor(NEW.prov_id);
    IF OLD.prov_id IS DISTINCT FROM NEW.prov_id THEN
      PERFORM fn_recalcular_saldo_proveedor(OLD.prov_id);
    END IF;
  END IF;
  RETURN NULL;  -- AFTER trigger: no afecta el resultado
END;
$$;

REVOKE ALL ON FUNCTION trg_saldo_proveedor() FROM PUBLIC;

-- ─── Triggers en facturas y remitos ──────────────────────────────────────
DROP TRIGGER IF EXISTS trg_saldo_prov_facturas ON facturas;
CREATE TRIGGER trg_saldo_prov_facturas
  AFTER INSERT OR UPDATE OR DELETE ON facturas
  FOR EACH ROW EXECUTE FUNCTION trg_saldo_proveedor();

DROP TRIGGER IF EXISTS trg_saldo_prov_remitos ON remitos;
CREATE TRIGGER trg_saldo_prov_remitos
  AFTER INSERT OR UPDATE OR DELETE ON remitos
  FOR EACH ROW EXECUTE FUNCTION trg_saldo_proveedor();

-- ─── Reescritura de RPCs existentes (sacar UPDATE proveedores.saldo) ─────
-- Las RPCs siguen haciendo el resto (UPDATE facturas/remitos, INSERT
-- movimiento, _actualizar_saldo_caja, _auditar). El UPDATE
-- proveedores.saldo lo cubre el trigger automáticamente cuando el RPC
-- modifica facturas.pagos / facturas.estado / remitos.estado.

CREATE OR REPLACE FUNCTION pagar_factura(
  p_factura_id text, p_monto numeric, p_cuenta text, p_fecha date,
  p_detalle text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fac RECORD; v_nuevos_pagos jsonb; v_total_pagado numeric;
  v_nuevo_estado text; v_mov_id text; v_detalle text; v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
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

  -- El UPDATE dispara trg_saldo_prov_facturas que recalcula el saldo del
  -- proveedor. Ya no hace falta UPDATE proveedores manual.
  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos WHERE id = p_factura_id;

  IF v_fac.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_fac.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  v_detalle := COALESCE(p_detalle, 'Pago Fact ' || COALESCE(v_fac.nro, v_fac.id));
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, fact_id, local_id, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_fac.cat,
    -p_monto, v_detalle, p_factura_id, v_fac.local_id, v_tenant);

  PERFORM _auditar('facturas', 'PAGO', jsonb_build_object(
    'factura_id', p_factura_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado, 'total_pagado', v_total_pagado);
END;
$$;

CREATE OR REPLACE FUNCTION pagar_remito(
  p_remito_id text, p_monto numeric, p_cuenta text, p_fecha date
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_r RECORD; v_prov RECORD; v_mov_id text; v_tenant uuid;
BEGIN
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_ANULADO'; END IF;
  IF v_r.estado = 'pagado' THEN RAISE EXCEPTION 'REMITO_YA_PAGADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  -- Trg_saldo_prov_remitos recalcula al cambiar estado a 'pagado'.
  UPDATE remitos SET estado = 'pagado' WHERE id = p_remito_id;

  SELECT * INTO v_prov FROM proveedores WHERE id = v_r.prov_id;

  IF v_r.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, v_r.local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, remito_id_ref, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, 'Pago Proveedor', v_r.cat, -p_monto,
    'Pago remito ' || COALESCE(v_r.nro, v_r.id) || COALESCE(' - ' || v_prov.nombre, ''),
    v_r.local_id, p_remito_id, v_tenant);

  PERFORM _auditar('remitos', 'PAGO', jsonb_build_object(
    'remito_id', p_remito_id, 'monto', p_monto, 'cuenta', p_cuenta,
    'mov_id', v_mov_id, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', 'pagado');
END;
$$;

CREATE OR REPLACE FUNCTION anular_factura(p_factura_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_fac RECORD; v_tenant uuid;
BEGIN
  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_YA_ANULADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  -- Trg recalcula saldo. No importa el estado anterior: el filtro del
  -- recálculo excluye 'anulada' y 'pagada' por igual, así que la transición
  -- pendiente→anulada o pagada→anulada queda manejada correctamente.
  UPDATE facturas SET estado = 'anulada' WHERE id = p_factura_id;

  PERFORM _auditar('facturas', 'ANULACION', jsonb_build_object(
    'factura_id', p_factura_id, 'motivo', p_motivo,
    'estado_previo', v_fac.estado, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada');
END;
$$;

CREATE OR REPLACE FUNCTION anular_remito(p_remito_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_r RECORD; v_tenant uuid;
BEGIN
  SELECT * INTO v_r FROM remitos WHERE id = p_remito_id;
  IF v_r IS NULL THEN RAISE EXCEPTION 'REMITO_NO_ENCONTRADO'; END IF;
  IF v_r.estado = 'anulado' THEN RAISE EXCEPTION 'REMITO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_r.local_id);
  v_tenant := v_r.tenant_id;

  -- Trg recalcula. El filtro WHERE estado='sin_factura' excluye 'anulado'.
  UPDATE remitos SET estado = 'anulado' WHERE id = p_remito_id;

  PERFORM _auditar('remitos', 'ANULACION', jsonb_build_object(
    'remito_id', p_remito_id, 'motivo', p_motivo,
    'estado_previo', v_r.estado, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('remito_id', p_remito_id, 'estado', 'anulado');
END;
$$;

-- ─── Backfill: recalcular saldo de TODOS los proveedores activos ─────────
-- Corre la función para cada fila. Esto convierte la columna persistida
-- (que tenía $2.7M sobreestimados según auditoría 2026-05-06) en el
-- valor correcto.
DO $$
DECLARE r RECORD; v_count INT := 0;
BEGIN
  FOR r IN SELECT id FROM proveedores LOOP
    PERFORM fn_recalcular_saldo_proveedor(r.id);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '[backfill saldo proveedor] % proveedores recalculados', v_count;
END$$;

-- ─── Verificación inline ─────────────────────────────────────────────────
-- Cuenta cuántos proveedores tienen diff > $1 entre saldo (recién recalculado)
-- y la fórmula re-aplicada manualmente. Debería ser 0.
DO $$
DECLARE v_diff INT;
BEGIN
  SELECT COUNT(*) INTO v_diff
  FROM proveedores p
  WHERE ABS(COALESCE(p.saldo, 0) - (
    COALESCE((
      SELECT SUM(CASE
        WHEN f.tipo = 'nota_credito' THEN -ABS(COALESCE(f.total, 0))
        ELSE GREATEST(0, COALESCE(f.total, 0) - COALESCE((
          SELECT SUM((pp->>'monto')::numeric)
          FROM jsonb_array_elements(COALESCE(f.pagos, '[]'::jsonb)) pp), 0))
      END)
      FROM facturas f
      WHERE f.prov_id = p.id AND f.estado NOT IN ('anulada','pagada')), 0)
    +
    COALESCE((
      SELECT SUM(COALESCE(r.monto, 0))
      FROM remitos r
      WHERE r.prov_id = p.id AND r.estado = 'sin_factura' AND r.factura_id IS NULL), 0)
  )) > 1;
  RAISE NOTICE '[verificación post-backfill] % proveedores con diff > $1 (esperado: 0)', v_diff;
END$$;
