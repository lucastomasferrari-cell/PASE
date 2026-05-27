-- =============================================================================
-- AUDIT F1 — 13 críticos auto-fixeables
-- Generada 2026-05-27 a partir de docs/audit-2026-05/01-bugs-financieros.md
-- =============================================================================
-- NO incluye los 2 que requieren decisión humana:
--   #3  pagar_remito validación de monto (¿exacto? ¿parcial? ¿margen?)
--   #6  pagar_sueldo sobrepago silencioso (¿abortar? ¿flag opt-in?)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- FIX #8: idempotency_keys SIN tenant_id en PK → colisión cross-tenant.
-- Tenant B puede recibir la respuesta cacheada del tenant A como
-- `idempotent_replay=true` y NO ejecutar el pago real. Pérdida de plata.
-- -----------------------------------------------------------------------------
-- Limpieza: rows huérfanas sin tenant_id (de antes de la migration multi-tenant).
-- Estas filas no tienen valor de replay para nadie y serían imposibles de
-- migrar al nuevo PK con NOT NULL.
DELETE FROM idempotency_keys WHERE tenant_id IS NULL;

ALTER TABLE idempotency_keys ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (rpc_name, key, tenant_id);

COMMENT ON TABLE idempotency_keys IS
  'Cache de respuestas idempotentes. PK (rpc_name, key, tenant_id) — el tenant es parte de la clave para evitar leak cross-tenant.';

-- -----------------------------------------------------------------------------
-- FIX #5: pagar_vacaciones / pagar_aguinaldo UNIQUE (empleado_id, tipo)
-- bloquea el 2do pago para SIEMPRE.
-- Time bomb: explota en SAC junio 2026 cuando empleados intenten cobrar
-- aguinaldo nuevo (el de cesantías históricas tomó la única slot disponible).
-- -----------------------------------------------------------------------------
ALTER TABLE rrhh_pagos_especiales ADD COLUMN IF NOT EXISTS anio INTEGER;
ALTER TABLE rrhh_pagos_especiales ADD COLUMN IF NOT EXISTS periodo TEXT;

-- Backfill: derivar anio/periodo de pagado_at de filas históricas.
-- Para vacaciones: periodo='vac' (1 pago por año, sigue la regla histórica).
-- Para aguinaldo:  periodo='jun' si pagado_at ≤ julio, 'dic' si después.
UPDATE rrhh_pagos_especiales SET
  anio = EXTRACT(year FROM pagado_at)::INTEGER,
  periodo = CASE
    WHEN tipo = 'vacaciones' THEN 'vac'
    WHEN tipo = 'aguinaldo' AND EXTRACT(month FROM pagado_at) <= 7 THEN 'jun'
    WHEN tipo = 'aguinaldo' THEN 'dic'
    ELSE 'legacy'
  END
WHERE anio IS NULL;

ALTER TABLE rrhh_pagos_especiales ALTER COLUMN anio SET NOT NULL;
ALTER TABLE rrhh_pagos_especiales ALTER COLUMN periodo SET NOT NULL;

ALTER TABLE rrhh_pagos_especiales DROP CONSTRAINT rrhh_pagos_especiales_empleado_tipo_unique;
DROP INDEX IF EXISTS rrhh_pagos_especiales_empleado_tipo_unique;

ALTER TABLE rrhh_pagos_especiales
  ADD CONSTRAINT rrhh_pagos_especiales_emp_tipo_anio_periodo_unique
  UNIQUE (empleado_id, tipo, anio, periodo);

COMMENT ON COLUMN rrhh_pagos_especiales.anio IS
  'Año del periodo pagado. Para aguinaldo permite jun+dic del mismo año; para vacaciones 1 por año.';
COMMENT ON COLUMN rrhh_pagos_especiales.periodo IS
  'Discriminador dentro del año: aguinaldo=''jun''|''dic''; vacaciones=''vac''.';

-- -----------------------------------------------------------------------------
-- FIX #13: fn_trg_sync_saldos_caja con varios bugs en uno:
--   a) Fallback a tenant Neko cuando local_id IS NULL contamina cross-tenant.
--   b) UNIQUE en saldos_caja(cuenta, local_id) trata NULL como != NULL,
--      cada INSERT con local_id NULL crea fila duplicada en lugar de upsert.
--   c) Usa `<>` en vez de `IS DISTINCT FROM` — cambios de/a NULL no resincronizan.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_trg_sync_saldos_caja()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Movimientos sin local_id no participan del cache de saldos por cuenta.
  -- (saldos_caja exige local_id para ser útil; sin local no hay a qué imputar)
  IF TG_OP = 'INSERT' AND NEW.local_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.local_id IS NULL THEN RETURN OLD; END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.local_id IS NOT NULL THEN
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      NEW.cuenta, NEW.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = NEW.local_id AND cuenta = NEW.cuenta AND NOT anulado),
      NEW.tenant_id
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  -- UPDATE con cambio de cuenta o local: además sincronizar el OLD.
  -- IS DISTINCT FROM trata NULL correctamente.
  IF TG_OP = 'UPDATE'
     AND (OLD.cuenta IS DISTINCT FROM NEW.cuenta
       OR OLD.local_id IS DISTINCT FROM NEW.local_id)
     AND OLD.local_id IS NOT NULL THEN
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      OLD.cuenta, OLD.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = OLD.local_id AND cuenta = OLD.cuenta AND NOT anulado),
      OLD.tenant_id
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  IF TG_OP = 'DELETE' AND OLD.local_id IS NOT NULL THEN
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      OLD.cuenta, OLD.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = OLD.local_id AND cuenta = OLD.cuenta AND NOT anulado),
      OLD.tenant_id
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #1: eliminar_cierre — quitar UPDATE saldos_caja manual (trigger lo hace).
-- Post 23-may, saldos_caja es cache derivado del ledger. La RPC seguía
-- bajando el saldo manualmente DESPUÉS del DELETE, mientras el trigger
-- también recalculaba — el orden no garantiza qué gana, pero en muchos
-- casos quedaba doble descuento.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eliminar_cierre(p_local_id integer, p_fecha date, p_turno text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta RECORD; v_mov RECORD;
  v_ventas_borradas int := 0; v_movs_borrados int := 0;
  v_movs_actualizados int := 0; v_contiene_legacy boolean := false;
  v_venta_ids_borrados text[] := ARRAY[]::text[];
  v_total_borrado numeric := 0; v_tenant uuid;
BEGIN
  IF p_local_id IS NULL OR p_fecha IS NULL OR p_turno IS NULL OR length(p_turno) = 0 THEN
    RAISE EXCEPTION 'PARAMETROS_REQUERIDOS';
  END IF;

  IF NOT auth_tiene_permiso_o_override(
    'ventas_anular',
    p_override_code,
    'eliminar_cierre',
    jsonb_build_object('local_id', p_local_id, 'fecha', p_fecha, 'turno', p_turno)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso ventas_anular o código del manager';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: local fuera de scope';
  END IF;

  SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;

  FOR v_venta IN SELECT * FROM ventas WHERE local_id = p_local_id AND fecha = p_fecha AND turno = p_turno LOOP
    SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[v_venta.id]::text[] LIMIT 1;
    IF v_mov.id IS NOT NULL THEN
      IF array_length(v_mov.venta_ids, 1) = 1 THEN
        -- AUDIT FIX #1: el trigger trg_sync_saldos_caja recalcula saldo
        -- como SUM(movimientos no anulados) → suficiente con el DELETE.
        DELETE FROM movimientos WHERE id = v_mov.id;
        v_movs_borrados := v_movs_borrados + 1;
      ELSE
        UPDATE movimientos
           SET importe = importe - v_venta.monto,
               venta_ids = array_remove(venta_ids, v_venta.id)
         WHERE id = v_mov.id;
        v_movs_actualizados := v_movs_actualizados + 1;
      END IF;
    ELSE
      v_contiene_legacy := true;
    END IF;
    v_total_borrado := v_total_borrado + v_venta.monto;
    v_venta_ids_borrados := array_append(v_venta_ids_borrados, v_venta.id);
    DELETE FROM ventas WHERE id = v_venta.id;
    v_ventas_borradas := v_ventas_borradas + 1;
  END LOOP;

  PERFORM _auditar('ventas', 'ELIMINAR_CIERRE', jsonb_build_object(
    'local_id', p_local_id, 'fecha', p_fecha, 'turno', p_turno,
    'ventas_borradas', v_ventas_borradas, 'movs_borrados', v_movs_borrados,
    'movs_actualizados', v_movs_actualizados, 'total_borrado', v_total_borrado,
    'contiene_legacy', v_contiene_legacy, 'venta_ids', v_venta_ids_borrados,
    'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object(
    'ventas_borradas', v_ventas_borradas,
    'movs_borrados', v_movs_borrados,
    'movs_actualizados', v_movs_actualizados,
    'total_borrado', v_total_borrado,
    'contiene_legacy', v_contiene_legacy
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #2: eliminar_venta — mismo bug que eliminar_cierre.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eliminar_venta(p_venta_id text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta RECORD; v_mov RECORD; v_saldo_delta numeric := 0;
  v_mov_borrado boolean := false; v_tenant uuid;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN RAISE EXCEPTION 'VENTA_ID_REQUERIDO'; END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF NOT auth_tiene_permiso_o_override(
    'ventas_anular',
    p_override_code,
    'eliminar_venta',
    jsonb_build_object('venta_id', p_venta_id, 'monto', v_venta.monto, 'local_id', v_venta.local_id)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso ventas_anular o código del manager';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: local fuera de scope';
  END IF;
  v_tenant := v_venta.tenant_id;

  SELECT * INTO v_mov FROM movimientos WHERE venta_ids @> ARRAY[p_venta_id]::text[] LIMIT 1;

  IF v_mov.id IS NOT NULL THEN
    IF array_length(v_mov.venta_ids, 1) = 1 THEN
      -- AUDIT FIX #2: el trigger trg_sync_saldos_caja recalcula saldo.
      DELETE FROM movimientos WHERE id = v_mov.id;
      v_saldo_delta := v_mov.importe;
      v_mov_borrado := true;
    ELSE
      UPDATE movimientos
         SET importe = importe - v_venta.monto,
             venta_ids = array_remove(venta_ids, p_venta_id)
       WHERE id = v_mov.id;
      v_saldo_delta := v_venta.monto;
    END IF;
  END IF;

  DELETE FROM ventas WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'ELIMINAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id, 'monto', v_venta.monto, 'medio', v_venta.medio,
    'local_id', v_venta.local_id, 'fecha', v_venta.fecha, 'turno', v_venta.turno,
    'mov_id', v_mov.id, 'mov_borrado', v_mov_borrado,
    'saldo_delta', v_saldo_delta, 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('venta_id', p_venta_id, 'mov_id', v_mov.id,
    'mov_borrado', v_mov_borrado, 'saldo_delta', v_saldo_delta);
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #4: anular_factura dejaba movimientos asociados ACTIVOS.
-- Bug confirmado en prod: FACT-1778176077832-myzh anulada con movimientos
-- vivos = plata fantasma en caja.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_factura(p_factura_id text, p_motivo text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fac RECORD;
  v_tenant uuid;
  v_movs_anulados integer := 0;
BEGIN
  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_factura',
    jsonb_build_object('factura_id', p_factura_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_YA_ANULADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);
  v_tenant := v_fac.tenant_id;

  UPDATE facturas SET estado = 'anulada' WHERE id = p_factura_id;

  -- AUDIT FIX #4: anular también los movimientos de pago asociados.
  -- El trigger recalcula saldos al marcar anulado=true.
  UPDATE movimientos
     SET anulado = true,
         anulado_motivo = COALESCE(p_motivo, 'Factura anulada')
   WHERE fact_id = p_factura_id
     AND COALESCE(anulado, false) = false;
  GET DIAGNOSTICS v_movs_anulados = ROW_COUNT;

  PERFORM _auditar('facturas', 'ANULACION', jsonb_build_object(
    'factura_id', p_factura_id, 'motivo', p_motivo,
    'estado_previo', v_fac.estado, 'movs_anulados', v_movs_anulados,
    'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('factura_id', p_factura_id, 'estado', 'anulada',
    'movs_anulados', v_movs_anulados);
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #11: anular_movimiento sin FOR UPDATE = doble anulación posible.
-- Las otras anular_* tienen el lock; quedó sin él. También se promueve a
-- SECURITY DEFINER (era SECURITY INVOKER, inconsistente con sus pares y
-- causaba que el UPDATE de rrhh_adelantos fallara silenciosamente por RLS).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_movimiento(p_mov_id text, p_motivo text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov RECORD;
  v_liq RECORD;
  v_emp_id uuid;
  v_movs_restantes integer;
  v_delta_aguinaldo numeric;
  v_gasto_id text;
  v_tenant uuid;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_movimiento',
    jsonb_build_object('mov_id', p_mov_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  -- AUDIT FIX #11: FOR UPDATE para evitar doble anulación concurrente.
  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;
  v_tenant := v_mov.tenant_id;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- saldo_caja: el trigger trg_sync_saldos_caja recalcula al ver anulado=true.
  -- (eliminada la llamada PERFORM _actualizar_saldo_caja que era NOOP)

  -- Si el movimiento estaba asociado a una liquidación de sueldo: lógica completa.
  IF v_mov.liquidacion_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = v_mov.liquidacion_id FOR UPDATE;

    SELECT COUNT(*) INTO v_movs_restantes
      FROM movimientos
     WHERE liquidacion_id = v_mov.liquidacion_id AND anulado IS NOT TRUE;

    IF v_movs_restantes = 0 THEN
      IF v_liq.estado = 'pagado' THEN
        SELECT n.empleado_id INTO v_emp_id
          FROM rrhh_novedades n
         WHERE n.id = v_liq.novedad_id;
        IF v_emp_id IS NOT NULL THEN
          v_delta_aguinaldo := COALESCE(v_liq.total_a_pagar, 0) / 12.0;
          UPDATE rrhh_empleados
             SET aguinaldo_acumulado = GREATEST(0, COALESCE(aguinaldo_acumulado, 0) - v_delta_aguinaldo)
           WHERE id = v_emp_id;
        END IF;
      END IF;

      UPDATE rrhh_adelantos
         SET descontado = false,
             liquidacion_consumidora_id = NULL
       WHERE liquidacion_consumidora_id = v_mov.liquidacion_id;

      UPDATE rrhh_liquidaciones
         SET anulado = true,
             pagos_realizados = 0,
             estado = 'pendiente'
             -- AUDIT FIX #7: NO blanqueamos pagado_at/pagado_por.
             -- Mantenemos el historial aunque el estado cambie.
       WHERE id = v_mov.liquidacion_id;
    ELSE
      UPDATE rrhh_liquidaciones
         SET pagos_realizados = GREATEST(0, COALESCE(pagos_realizados, 0) - ABS(COALESCE(v_mov.importe, 0)))
       WHERE id = v_mov.liquidacion_id;
    END IF;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
    SELECT id INTO v_gasto_id FROM gastos
    WHERE detalle = v_mov.detalle AND fecha = v_mov.fecha
      AND cuenta = v_mov.cuenta AND local_id = v_mov.local_id
    LIMIT 1;
    IF v_gasto_id IS NOT NULL THEN
      UPDATE rrhh_liquidaciones SET anulado = true WHERE gasto_id = v_gasto_id;
    END IF;
  END IF;

  PERFORM _auditar('movimientos', 'ANULACION', jsonb_build_object(
    'mov_id', p_mov_id, 'motivo', p_motivo,
    'movimiento', to_jsonb(v_mov), 'usuario_id', auth_usuario_id(),
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #9: pagar_sueldo sin FOR UPDATE sobre rrhh_liquidaciones.
-- Causa probable del bug histórico C4-F14 (Caro: 2 movs huérfanos del mismo
-- pago). También FIX #7: preservar pagado_at/pagado_por.
-- También FIX #8: idempotency con tenant_id en filter+insert.
-- (NO incluye FIX #6 sobrepago — requiere decisión humana.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pagar_sueldo(p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[], p_fecha date, p_mes integer, p_anio integer, p_crear_liq boolean DEFAULT false, p_calc jsonb DEFAULT NULL::jsonb, p_idempotency_key text DEFAULT NULL::text, p_liq_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_liq RECORD; v_fp jsonb; v_monto numeric; v_cuenta text;
  v_linea_local_id integer;
  v_asignado_cash numeric := 0; v_total_adelantos numeric := 0;
  v_total_a_pagar numeric; v_ya_pagado numeric; v_pendiente numeric;
  v_asignado_total numeric; v_completa boolean; v_nuevos_pagos numeric;
  v_sobrepago numeric := 0;
  v_mov_ids text[] := ARRAY[]::text[]; v_mov_id text; v_desc text;
  v_meses_nombre text[] := ARRAY['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  v_tenant uuid;
  v_cached jsonb;
  v_result jsonb;
  v_count_liqs integer;
  v_cuota_label text;
  v_locales_pagaron integer[];
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- AUDIT FIX #8: filtro por tenant en idempotency lookup.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'pagar_sueldo' AND key = p_idempotency_key AND tenant_id = v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay', true); END IF;
  END IF;

  IF p_nov_id IS NULL THEN RAISE EXCEPTION 'NOVEDAD_INVALIDA'; END IF;

  SELECT e.* INTO v_emp FROM rrhh_empleados e
    JOIN rrhh_novedades n ON n.empleado_id = e.id
   WHERE n.id = p_nov_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);

  -- AUDIT FIX #9: FOR UPDATE en rrhh_liquidaciones para evitar race condition
  -- de doble pago concurrente.
  IF p_liq_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = p_liq_id FOR UPDATE;
    IF v_liq IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
    IF v_liq.novedad_id IS DISTINCT FROM p_nov_id THEN
      RAISE EXCEPTION 'LIQUIDACION_NOVEDAD_MISMATCH';
    END IF;
  ELSE
    SELECT COUNT(*) INTO v_count_liqs FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
    IF v_count_liqs > 1 THEN
      RAISE EXCEPTION 'MULTIPLES_CUOTAS_REQUIERE_LIQ_ID';
    END IF;
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id FOR UPDATE;
    IF v_liq IS NULL THEN
      IF NOT p_crear_liq OR p_calc IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
      INSERT INTO rrhh_liquidaciones (
        novedad_id, sueldo_base, descuento_ausencias, total_horas_extras,
        total_dobles, total_feriados, total_vacaciones, subtotal1,
        monto_presentismo, subtotal2, adelantos, pagos_realizados,
        total_a_pagar, efectivo, transferencia, estado, calculado_at, tenant_id,
        cuota_num, cuotas_total
      ) VALUES (
        p_nov_id,
        (p_calc->>'sueldo_base')::numeric, (p_calc->>'descuento_ausencias')::numeric,
        (p_calc->>'total_horas_extras')::numeric, (p_calc->>'total_dobles')::numeric,
        (p_calc->>'total_feriados')::numeric, COALESCE((p_calc->>'total_vacaciones')::numeric, 0),
        (p_calc->>'subtotal1')::numeric, (p_calc->>'monto_presentismo')::numeric,
        (p_calc->>'subtotal2')::numeric, COALESCE((p_calc->>'adelantos')::numeric, 0),
        0, (p_calc->>'total_a_pagar')::numeric,
        COALESCE((p_calc->>'efectivo')::numeric, 0),
        COALESCE((p_calc->>'transferencia')::numeric, 0),
        'pendiente', now(), v_tenant,
        1, 1
      ) RETURNING * INTO v_liq;
    END IF;
  END IF;

  IF v_liq.anulado IS TRUE THEN RAISE EXCEPTION 'LIQUIDACION_ANULADA'; END IF;
  IF v_liq.estado = 'pagado' THEN RAISE EXCEPTION 'LIQUIDACION_YA_PAGADA'; END IF;

  v_total_a_pagar := ROUND(COALESCE(v_liq.total_a_pagar, 0));
  v_ya_pagado := ROUND(COALESCE(v_liq.pagos_realizados, 0));
  v_pendiente := GREATEST(0, v_total_a_pagar - v_ya_pagado);

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(monto), 0) INTO v_total_adelantos FROM rrhh_adelantos
     WHERE id = ANY(p_adelantos_ids) AND descontado = false FOR UPDATE;
  END IF;
  v_total_adelantos := ROUND(v_total_adelantos);

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_asignado_cash := v_asignado_cash + v_monto;
  END LOOP;

  v_asignado_total := v_asignado_cash + v_total_adelantos;
  IF v_asignado_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  v_completa := v_asignado_total >= v_pendiente;
  v_sobrepago := GREATEST(0, v_asignado_total - v_pendiente);
  v_nuevos_pagos := LEAST(v_total_a_pagar, v_ya_pagado + v_asignado_total);

  IF COALESCE(v_liq.cuotas_total, 1) > 1 THEN
    v_cuota_label := ' [Cuota ' || v_liq.cuota_num || '/' || v_liq.cuotas_total || ']';
  ELSE
    v_cuota_label := '';
  END IF;

  v_desc := CASE
    WHEN v_completa AND v_ya_pagado = 0 THEN 'Sueldo'
    WHEN v_completa THEN 'Sueldo (saldo final)'
    ELSE 'Sueldo (parcial)'
  END || ' ' || v_emp.apellido || ' ' || v_emp.nombre
    || ' - ' || v_meses_nombre[p_mes+1] || ' ' || p_anio
    || v_cuota_label
    || CASE WHEN v_sobrepago > 0
            THEN ' (sobrepago $' || v_sobrepago::text || ')'
            ELSE '' END;

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_fp->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    v_linea_local_id := COALESCE(
      NULLIF(v_fp->>'local_id', '')::integer,
      v_emp.local_id
    );

    PERFORM _validar_local_autorizado(v_linea_local_id);

    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, liquidacion_id, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Sueldo', 'SUELDOS',
      -v_monto,
      v_desc || CASE
        WHEN v_emp.local_id IS NOT NULL AND v_linea_local_id IS NOT NULL
             AND v_linea_local_id <> v_emp.local_id
        THEN ' [pago repartido]'
        ELSE ''
      END,
      v_linea_local_id, v_liq.id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
    v_locales_pagaron := array_append(v_locales_pagaron, v_linea_local_id);
  END LOOP;

  -- AUDIT FIX #7: pagado_at/pagado_por solo se setean al completar.
  -- En sucesivos parciales NO se tocan. _resync (al anular) tampoco los blanquea.
  UPDATE rrhh_liquidaciones
     SET pagos_realizados = v_nuevos_pagos,
         estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
         pagado_at = CASE
           WHEN v_completa AND pagado_at IS NULL THEN now()
           ELSE pagado_at
         END,
         pagado_por = CASE
           WHEN v_completa AND pagado_por IS NULL THEN auth_usuario_id()::text
           ELSE pagado_por
         END
   WHERE id = v_liq.id;

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    UPDATE rrhh_adelantos
       SET descontado = true,
           liquidacion_consumidora_id = v_liq.id
     WHERE id = ANY(p_adelantos_ids);
  END IF;

  IF v_completa THEN
    UPDATE rrhh_empleados
       SET aguinaldo_acumulado = COALESCE(aguinaldo_acumulado, 0) + v_total_a_pagar / 12.0
     WHERE id = v_emp.id;
  END IF;

  PERFORM _auditar('rrhh_liquidaciones', 'PAGO', jsonb_build_object(
    'liquidacion_id', v_liq.id, 'monto_asignado', v_asignado_total,
    'sobrepago', v_sobrepago,
    'completa', v_completa, 'mov_ids', v_mov_ids,
    'cuota_num', v_liq.cuota_num, 'cuotas_total', v_liq.cuotas_total,
    'adelantos_ids', p_adelantos_ids, 'usuario_id', auth_usuario_id(),
    'locales_pagaron', v_locales_pagaron,
    'pago_repartido', (array_length(ARRAY(SELECT DISTINCT unnest(v_locales_pagaron)), 1) > 1)
  ), v_tenant);

  v_result := jsonb_build_object(
    'liquidacion_id', v_liq.id,
    'mov_ids', v_mov_ids,
    'completa', v_completa,
    'pagos_realizados', v_nuevos_pagos,
    'pendiente', GREATEST(0, v_total_a_pagar - v_nuevos_pagos),
    'sobrepago', v_sobrepago,
    'cuota_num', v_liq.cuota_num,
    'cuotas_total', v_liq.cuotas_total,
    'locales_pagaron', v_locales_pagaron
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('pagar_sueldo', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #7: _resync_liquidacion_pagos blanqueaba pagado_at/pagado_por al re-evaluar.
-- Cuando la liquidación baja de completa a pendiente (anulación parcial),
-- ahora preservamos el historial. Si vuelve a estar completa, mantenemos
-- el at/por originales (no son sobrescritos por COALESCE).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._resync_liquidacion_pagos(p_liq_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total NUMERIC;
  v_pagado NUMERIC;
  v_completa BOOLEAN;
BEGIN
  IF p_liq_id IS NULL THEN RETURN; END IF;

  SELECT total_a_pagar INTO v_total
    FROM rrhh_liquidaciones WHERE id = p_liq_id;
  IF v_total IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(-importe), 0) INTO v_pagado
    FROM movimientos
    WHERE liquidacion_id = p_liq_id
      AND COALESCE(anulado, false) = false;

  v_completa := v_pagado >= (v_total - 1);

  -- AUDIT FIX #7: pagado_at y pagado_por NUNCA se blanquean.
  -- Se setean SOLO si quedó completa y no había historial previo.
  UPDATE rrhh_liquidaciones
    SET pagos_realizados = v_pagado,
        estado = CASE WHEN v_completa THEN 'pagado' ELSE 'pendiente' END,
        pagado_at = CASE
          WHEN v_completa AND pagado_at IS NULL THEN NOW()
          ELSE pagado_at
        END
        -- pagado_por: nunca se toca acá; lo setea quien pagó originalmente.
    WHERE id = p_liq_id;
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #10: aplicar_nc_a_factura race condition en SUM + sin idempotency.
-- 2 calls concurrentes ambas leen v_nc_aplicado=0, ambas insertan → NC
-- consumida 2×. Fix: advisory lock por NC + p_idempotency_key.
-- -----------------------------------------------------------------------------
-- Drop versión vieja (4 args) para evitar overload duplicado — agregar
-- p_idempotency_key con DEFAULT no reemplaza la firma original sino que
-- crea una sobrecarga nueva, dejando la buggy seleccionable.
DROP FUNCTION IF EXISTS public.aplicar_nc_a_factura(text, text, numeric, date);

CREATE OR REPLACE FUNCTION public.aplicar_nc_a_factura(p_nc_id text, p_factura_id text, p_monto numeric, p_fecha date, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_cached       jsonb;
  v_result       jsonb;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  -- AUDIT FIX #10a: idempotency check.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'aplicar_nc_a_factura' AND key = p_idempotency_key AND tenant_id = v_tenant;
    IF v_cached IS NOT NULL THEN
      RETURN v_cached || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_fecha IS NULL THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;

  -- AUDIT FIX #10b: advisory lock por NC. Serializa todas las aplicaciones
  -- sobre la misma NC, garantizando que el SUM(monto) sea consistente con
  -- el INSERT que viene después. Hash del nc_id como key del lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('aplicar_nc:' || p_nc_id, 0));

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

  -- SUM bajo el advisory lock: ya está serializado, valor consistente.
  SELECT COALESCE(SUM(monto), 0) INTO v_nc_aplicado
    FROM nc_aplicaciones WHERE nc_id = p_nc_id;
  v_nc_disp := abs(v_nc.total) - v_nc_aplicado;
  IF p_monto > v_nc_disp THEN
    RAISE EXCEPTION 'NC_SALDO_INSUFICIENTE';
  END IF;

  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_fac_pagado
    FROM jsonb_array_elements(COALESCE(v_fac.pagos, '[]'::jsonb)) e;
  v_fac_pendiente := v_fac.total - v_fac_pagado;
  IF p_monto > v_fac_pendiente THEN
    RAISE EXCEPTION 'FACTURA_MONTO_EXCEDE_PENDIENTE';
  END IF;

  INSERT INTO nc_aplicaciones (nc_id, factura_id, monto, fecha, tenant_id, usuario_id)
  VALUES (p_nc_id, p_factura_id, p_monto, p_fecha, v_tenant, v_usuario_id);

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

  v_nuevo_estado_nc := CASE
    WHEN (v_nc_aplicado + p_monto) >= abs(v_nc.total) THEN 'pagada'
    ELSE v_nc.estado
  END;
  IF v_nuevo_estado_nc <> v_nc.estado THEN
    UPDATE facturas SET estado = v_nuevo_estado_nc WHERE id = p_nc_id;
  END IF;

  PERFORM _auditar('facturas', 'APLICAR_NC', jsonb_build_object(
    'nc_id', p_nc_id, 'factura_id', p_factura_id, 'monto', p_monto,
    'usuario_id', v_usuario_id,
    'nc_estado_nuevo', v_nuevo_estado_nc, 'fac_estado_nuevo', v_nuevo_estado_fac
  ), v_tenant);

  v_result := jsonb_build_object(
    'nc_id', p_nc_id,
    'factura_id', p_factura_id,
    'monto', p_monto,
    'nc_estado', v_nuevo_estado_nc,
    'fac_estado', v_nuevo_estado_fac,
    'nc_saldo_restante', v_nc_disp - p_monto,
    'fac_saldo_pendiente', v_fac_pendiente - p_monto
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('aplicar_nc_a_factura', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #12: pagar_factura idempotency rota (cross-RPC + respuesta incompleta).
-- Antes usaba movimientos.idempotency_key + filtro hardcoded.
-- Ahora migra a la tabla idempotency_keys con tenant en PK.
-- (FIX #8 aplica acá también: tenant en filter+insert)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pagar_factura(p_factura_id text, p_monto numeric, p_cuenta text, p_fecha date, p_detalle text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fac RECORD; v_mov_id text; v_tenant uuid;
  v_nuevos_pagos jsonb; v_total_pagado numeric; v_nuevo_estado text;
  v_detalle text;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- AUDIT FIX #12: idempotency vía tabla canónica (no más hack con
  -- movimientos.idempotency_key + filtro hardcoded).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'pagar_factura' AND key = p_idempotency_key AND tenant_id = v_tenant;
    IF v_cached IS NOT NULL THEN
      RETURN v_cached || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;
  IF v_fac IS NULL THEN RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA'; END IF;
  IF v_fac.estado = 'anulada' THEN RAISE EXCEPTION 'FACTURA_ANULADA'; END IF;
  IF v_fac.estado = 'pagada' THEN RAISE EXCEPTION 'FACTURA_YA_PAGADA'; END IF;

  PERFORM _validar_local_autorizado(v_fac.local_id);

  v_nuevos_pagos := COALESCE(v_fac.pagos, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('cuenta', p_cuenta, 'monto', p_monto, 'fecha', p_fecha));
  SELECT COALESCE(SUM((e->>'monto')::numeric), 0) INTO v_total_pagado
  FROM jsonb_array_elements(v_nuevos_pagos) e;
  v_nuevo_estado := CASE WHEN v_total_pagado >= v_fac.total THEN 'pagada' ELSE 'pendiente' END;

  UPDATE facturas SET estado = v_nuevo_estado, pagos = v_nuevos_pagos WHERE id = p_factura_id;

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

  v_result := jsonb_build_object('mov_id', v_mov_id, 'nuevo_estado', v_nuevo_estado, 'total_pagado', v_total_pagado);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('pagar_factura', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #14: fn_conciliar_mp_* llaman a _actualizar_saldo_caja que es NOOP.
-- 3 RPCs ensucian con calls sin efecto. El trigger trg_sync_saldos_caja
-- ya hace el trabajo real. Eliminar las llamadas evita bomba latente
-- (si alguien "arregla" _actualizar_saldo_caja, doble descuento).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_conciliar_mp_con_factura_nueva(p_mp_mov_id text, p_factura_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp           RECORD;
  v_usuario_id   integer;
  v_factura_id   text;
  v_mov_id       text;
  v_monto_abs    numeric;
  v_prov_id      integer;
  v_nro          text;
  v_fecha        date;
  v_cat          text;
  v_cat_form     text;
  v_prov_cat     text;
  v_detalle      text;
  v_prov_existe  boolean;
  v_bucket       text;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_prov_id := (p_factura_data->>'prov_id')::integer;
  IF v_prov_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_REQUERIDO'; END IF;
  v_nro := nullif(trim(p_factura_data->>'nro'), '');
  IF v_nro IS NULL THEN RAISE EXCEPTION 'NRO_REQUERIDO'; END IF;
  v_cat_form := nullif(trim(p_factura_data->>'cat'), '');
  v_detalle  := COALESCE(p_factura_data->>'detalle', '');

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  v_fecha := COALESCE(
    nullif(p_factura_data->>'fecha', '')::date,
    (v_mp.fecha)::date,
    current_date
  );

  SELECT cat INTO v_prov_cat FROM proveedores
   WHERE id = v_prov_id AND tenant_id = v_mp.tenant_id;
  v_prov_existe := FOUND;
  IF NOT v_prov_existe THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  v_cat := COALESCE(v_cat_form, nullif(trim(v_prov_cat), ''), 'Conciliación MP');

  SELECT tipo INTO v_bucket
  FROM config_categorias
  WHERE nombre = v_cat AND tenant_id = v_mp.tenant_id AND activo = true
  LIMIT 1;

  v_factura_id := _gen_id('FAC');
  INSERT INTO facturas (
    id, prov_id, local_id, nro, fecha, venc, neto, iva21, iva105, iibb,
    total, cat, estado, detalle, pagos, tipo, perc_iva, otros_cargos, descuentos,
    tenant_id, bucket
  ) VALUES (
    v_factura_id, v_prov_id, v_mp.local_id, v_nro, v_fecha, NULL,
    v_monto_abs, 0, 0, 0,
    v_monto_abs, v_cat, 'pagada',
    COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
    jsonb_build_array(jsonb_build_object('fecha', v_fecha, 'monto', v_monto_abs, 'cuenta', 'MercadoPago')),
    'factura', 0, 0, 0,
    v_mp.tenant_id, v_bucket
  );

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
    VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Factura', v_cat,
            -v_monto_abs, COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
            v_mp.local_id, v_mp.tenant_id, v_factura_id);

  -- AUDIT FIX #14: eliminada llamada a _actualizar_saldo_caja (NOOP).
  -- El trigger trg_sync_saldos_caja sincroniza saldos_caja al ver el INSERT.

  UPDATE mp_movimientos
     SET justificativo_tipo = 'factura',
         justificativo_id   = v_factura_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_CREAR_FACTURA', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'factura_id', v_factura_id, 'mov_id', v_mov_id,
    'monto', v_monto_abs, 'cat', v_cat, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'factura',
                            'factura_id', v_factura_id, 'mov_id', v_mov_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_conciliar_mp_con_gasto(p_mp_mov_id text, p_gasto_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp          RECORD;
  v_usuario_id  integer;
  v_gasto_id    text;
  v_mov_id      text;
  v_monto_abs   numeric;
  v_categoria   text;
  v_detalle     text;
  v_gasto_tipo  text;
  v_fecha       date;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_categoria := nullif(trim(p_gasto_data->>'categoria'), '');
  IF v_categoria IS NULL THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;
  v_detalle    := COALESCE(p_gasto_data->>'detalle', '');
  v_gasto_tipo := COALESCE(nullif(trim(p_gasto_data->>'tipo'), ''), 'variable');

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  v_fecha := COALESCE((v_mp.fecha)::date, current_date);

  v_gasto_id := _gen_id('GASTO');
  INSERT INTO gastos (id, fecha, local_id, tenant_id, categoria, monto, detalle, tipo, cuenta)
    VALUES (v_gasto_id, v_fecha, v_mp.local_id, v_mp.tenant_id, v_categoria, v_monto_abs,
            COALESCE(nullif(v_detalle, ''), 'Conciliación MP'), v_gasto_tipo, 'MercadoPago');

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
    VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Gasto', v_categoria,
            -v_monto_abs, COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
            v_mp.local_id, v_mp.tenant_id, NULL);

  -- AUDIT FIX #14: eliminada llamada a _actualizar_saldo_caja (NOOP).

  UPDATE mp_movimientos
     SET justificativo_tipo = 'gasto',
         justificativo_id   = v_gasto_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_CREAR_GASTO', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'gasto_id', v_gasto_id, 'mov_id', v_mov_id,
    'monto', v_monto_abs, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'gasto',
                            'gasto_id', v_gasto_id, 'mov_id', v_mov_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_conciliar_mp_con_movimiento_interno(p_mp_mov_id text, p_destino_cuenta text, p_detalle text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp          RECORD;
  v_usuario_id  integer;
  v_mov_out_id  text;
  v_mov_in_id   text;
  v_monto_abs   numeric;
  v_detalle     text;
  v_fecha       date;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL          THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO';      END IF;
  IF p_destino_cuenta IS NULL OR trim(p_destino_cuenta) = '' THEN
    RAISE EXCEPTION 'DESTINO_CUENTA_REQUERIDA';
  END IF;
  IF trim(p_destino_cuenta) = 'MercadoPago' THEN
    RAISE EXCEPTION 'DESTINO_NO_PUEDE_SER_ORIGEN';
  END IF;

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  v_detalle := COALESCE(nullif(trim(p_detalle), ''), 'Transferencia MP → ' || p_destino_cuenta);
  v_fecha := COALESCE((v_mp.fecha)::date, current_date);

  v_mov_out_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id)
    VALUES (v_mov_out_id, v_fecha, 'MercadoPago', 'Transferencia entre cuentas',
            'MOVIMIENTO_INTERNO', -v_monto_abs, v_detalle, v_mp.local_id, v_mp.tenant_id);
  -- AUDIT FIX #14: eliminada llamada a _actualizar_saldo_caja (NOOP).

  v_mov_in_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id)
    VALUES (v_mov_in_id, v_fecha, p_destino_cuenta, 'Transferencia entre cuentas',
            'MOVIMIENTO_INTERNO', v_monto_abs, v_detalle, v_mp.local_id, v_mp.tenant_id);
  -- AUDIT FIX #14: eliminada llamada a _actualizar_saldo_caja (NOOP).

  UPDATE mp_movimientos
     SET justificativo_tipo = 'movimiento_interno',
         justificativo_id   = v_mov_out_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_MOVIMIENTO_INTERNO', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'mov_out_id', v_mov_out_id, 'mov_in_id', v_mov_in_id,
    'destino', p_destino_cuenta, 'monto', v_monto_abs, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'movimiento_interno',
                            'mov_out_id', v_mov_out_id, 'mov_in_id', v_mov_in_id,
                            'destino', p_destino_cuenta);
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #15: crear_gasto_empleado hacía UPDATE saldos_caja manual antes del INSERT
-- en movimientos. El trigger recalcula desde SUM(movimientos) → el UPDATE manual
-- queda overwriteado. No es doble descuento (porque el trigger LEE state actual)
-- pero deja state intermedio inconsistente y es bomba latente si el trigger
-- cambiara a delta-based.
-- También FIX #8: idempotency con tenant_id en filter+insert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_gasto_empleado(p_local_id integer, p_empleado_id uuid, p_concepto text, p_monto numeric, p_cuenta text, p_fecha date, p_detalle text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS TABLE(gasto_id text, adelanto_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_id UUID;
  v_emp_local_id INTEGER;
  v_gasto_id TEXT;
  v_adelanto_id UUID;
  v_emp_nombre TEXT;
  v_concepto_label TEXT;
  v_cached JSONB;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_concepto NOT IN ('adelanto','dia_doble','horas_extras','feriado','comida','viatico','otros') THEN
    RAISE EXCEPTION 'CONCEPTO_INVALIDO';
  END IF;
  IF p_cuenta IS NULL OR length(trim(p_cuenta)) = 0 THEN
    RAISE EXCEPTION 'CUENTA_REQUERIDA';
  END IF;

  -- AUDIT FIX #8: filtro por tenant en idempotency lookup.
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'crear_gasto_empleado' AND key = p_idempotency_key AND tenant_id = v_tenant_id;
    IF v_cached IS NOT NULL THEN
      RETURN QUERY SELECT
        (v_cached->>'gasto_id')::TEXT,
        (v_cached->>'adelanto_id')::UUID;
      RETURN;
    END IF;
  END IF;

  SELECT local_id, nombre INTO v_emp_local_id, v_emp_nombre
    FROM rrhh_empleados
   WHERE id = p_empleado_id
     AND tenant_id = v_tenant_id
     AND COALESCE(activo, TRUE) = TRUE;
  IF v_emp_local_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  v_concepto_label := CASE p_concepto
    WHEN 'adelanto'     THEN 'Adelanto'
    WHEN 'dia_doble'    THEN 'Día doble'
    WHEN 'horas_extras' THEN 'Horas extra'
    WHEN 'feriado'      THEN 'Feriado'
    WHEN 'comida'       THEN 'Comida'
    WHEN 'viatico'      THEN 'Viático'
    WHEN 'otros'        THEN 'Otros'
  END;

  v_gasto_id := gen_random_uuid()::TEXT;
  INSERT INTO gastos (
    id, tenant_id, local_id, fecha, tipo, categoria, monto, detalle, cuenta, estado
  ) VALUES (
    v_gasto_id, v_tenant_id, p_local_id, p_fecha, 'empleado',
    v_concepto_label, p_monto,
    COALESCE(p_detalle, v_emp_nombre || ' — ' || v_concepto_label),
    p_cuenta, 'activo'
  );

  IF p_concepto = 'adelanto' THEN
    INSERT INTO rrhh_adelantos (
      tenant_id, empleado_id, fecha, monto, cuenta,
      descontado, concepto, gasto_id, registrado_por
    ) VALUES (
      v_tenant_id, p_empleado_id, p_fecha, p_monto, p_cuenta,
      FALSE, p_concepto, v_gasto_id, auth.uid()::text
    ) RETURNING id INTO v_adelanto_id;
  ELSE
    v_adelanto_id := NULL;
  END IF;

  -- AUDIT FIX #15: eliminado UPDATE saldos_caja manual.
  -- El trigger trg_sync_saldos_caja recalcula al ver el INSERT siguiente.

  INSERT INTO movimientos (
    id, tenant_id, local_id, fecha, tipo, cat, importe, cuenta, detalle,
    gasto_id_ref, adelanto_id_ref, anulado
  ) VALUES (
    gen_random_uuid()::TEXT, v_tenant_id, p_local_id, p_fecha,
    'Gasto empleado', v_concepto_label, -p_monto, p_cuenta,
    v_emp_nombre || ' — ' || v_concepto_label,
    v_gasto_id, v_adelanto_id, FALSE
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES (
      'crear_gasto_empleado', p_idempotency_key, v_tenant_id,
      jsonb_build_object('gasto_id', v_gasto_id, 'adelanto_id', v_adelanto_id)
    )
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_gasto_id, v_adelanto_id;
END;
$function$;

-- -----------------------------------------------------------------------------
-- FIX #5 (parte 2): pagar_vacaciones / pagar_aguinaldo setean anio + periodo.
-- Sin esto el INSERT explota por NOT NULL después del cambio de schema.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pagar_vacaciones(p_empleado_id uuid, p_lineas jsonb, p_dias numeric, p_monto_esperado numeric, p_fecha date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_linea jsonb; v_cuenta text; v_monto numeric;
  v_total_pagado numeric := 0; v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text; v_pago_id uuid; v_pendiente boolean; v_desc text;
  v_tenant uuid;
  v_anio integer;
BEGIN
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_dias IS NULL OR p_dias <= 0 THEN RAISE EXCEPTION 'DIAS_INVALIDOS'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Vacaciones ' || p_dias::text || ' días ' || v_emp.apellido || ' ' || v_emp.nombre;
  v_anio := EXTRACT(year FROM p_fecha)::integer;

  v_pago_id := gen_random_uuid();
  -- AUDIT FIX #5: setear anio + periodo. UNIQUE (empleado, tipo, anio, periodo)
  -- permite 1 pago de vacaciones por año (la regla histórica), pero ya no
  -- bloquea para siempre.
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, dias, pendiente, gasto_id, pagado_por, tenant_id, anio, periodo)
  VALUES (v_pago_id, p_empleado_id, 'vacaciones',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, p_dias, v_pendiente,
    NULL, auth_usuario_id(), v_tenant, v_anio, 'vac');

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Vacaciones', 'SUELDOS', -v_monto, v_desc, v_emp.local_id, v_pago_id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET vacaciones_dias_acumulados = GREATEST(0, vacaciones_dias_acumulados - p_dias)
      WHERE id = p_empleado_id;
  END IF;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$function$;

CREATE OR REPLACE FUNCTION public.pagar_aguinaldo(p_empleado_id uuid, p_lineas jsonb, p_monto_esperado numeric, p_fecha date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp RECORD; v_linea jsonb; v_cuenta text; v_monto numeric;
  v_total_pagado numeric := 0; v_mov_ids text[] := ARRAY[]::text[];
  v_mov_id text; v_pago_id uuid; v_pendiente boolean; v_desc text;
  v_tenant uuid;
  v_anio integer;
  v_periodo text;
BEGIN
  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_empleado_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  IF p_lineas IS NULL OR jsonb_array_length(p_lineas) = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_total_pagado := v_total_pagado + v_monto;
  END LOOP;

  IF v_total_pagado <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  v_pendiente := v_total_pagado < COALESCE(p_monto_esperado, v_total_pagado) - 0.01;
  v_desc := 'Aguinaldo ' || v_emp.apellido || ' ' || v_emp.nombre;
  v_anio := EXTRACT(year FROM p_fecha)::integer;
  -- Convención: SAC jun = enero-junio, SAC dic = julio-diciembre.
  v_periodo := CASE WHEN EXTRACT(month FROM p_fecha) <= 7 THEN 'jun' ELSE 'dic' END;

  v_pago_id := gen_random_uuid();
  -- AUDIT FIX #5: setear anio + periodo. UNIQUE permite jun + dic del mismo
  -- año, y vuelve a permitirlo el año siguiente.
  INSERT INTO rrhh_pagos_especiales (id, empleado_id, tipo, monto, monto_pagado, pendiente, gasto_id, pagado_por, tenant_id, anio, periodo)
  VALUES (v_pago_id, p_empleado_id, 'aguinaldo',
    COALESCE(p_monto_esperado, v_total_pagado), v_total_pagado, v_pendiente,
    NULL, auth_usuario_id(), v_tenant, v_anio, v_periodo);

  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_linea->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, pago_especial_id_ref, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Aguinaldo', 'SUELDOS', -v_monto, v_desc, v_emp.local_id, v_pago_id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  IF NOT v_pendiente THEN
    UPDATE rrhh_empleados SET aguinaldo_acumulado = 0 WHERE id = p_empleado_id;
  END IF;

  RETURN jsonb_build_object('pago_id', v_pago_id, 'mov_ids', to_jsonb(v_mov_ids), 'pendiente', v_pendiente);
END;
$function$;

-- =============================================================================
-- SMOKE CHECKS — fallan si algo se rompió.
-- =============================================================================

DO $$
DECLARE
  v_pk_cols text;
  v_cnt integer;
BEGIN
  -- FIX #8: idempotency_keys PK debe incluir tenant_id
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO v_pk_cols
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.conrelid = 'idempotency_keys'::regclass AND c.contype = 'p';
  IF v_pk_cols IS NULL OR position('tenant_id' IN v_pk_cols) = 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: idempotency_keys PK no incluye tenant_id (got: %)', v_pk_cols;
  END IF;
  RAISE NOTICE 'SMOKE OK #8: idempotency_keys PK = (%)', v_pk_cols;

  -- FIX #5: rrhh_pagos_especiales debe tener (empleado_id, tipo, anio, periodo)
  SELECT COUNT(*) INTO v_cnt
  FROM pg_constraint c
  WHERE c.conrelid = 'rrhh_pagos_especiales'::regclass
    AND c.conname = 'rrhh_pagos_especiales_emp_tipo_anio_periodo_unique';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL: nuevo UNIQUE en rrhh_pagos_especiales no encontrado';
  END IF;
  RAISE NOTICE 'SMOKE OK #5: nuevo UNIQUE rrhh_pagos_especiales presente';

  -- Verificar que rrhh_pagos_especiales tiene anio + periodo NOT NULL
  SELECT COUNT(*) INTO v_cnt
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='rrhh_pagos_especiales'
    AND column_name IN ('anio','periodo') AND is_nullable='NO';
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'SMOKE FAIL: rrhh_pagos_especiales.anio/periodo no son NOT NULL';
  END IF;
  RAISE NOTICE 'SMOKE OK #5: anio + periodo NOT NULL';
END $$;

COMMIT;
