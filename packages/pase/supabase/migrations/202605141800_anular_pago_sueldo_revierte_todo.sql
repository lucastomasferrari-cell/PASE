-- ═══════════════════════════════════════════════════════════════════════════
-- BUGFIX (auditoría 2026-05-14): anular_movimiento de un pago de sueldo no
-- revertía 3 efectos colaterales que pagar_sueldo había producido:
--
--   1. rrhh_adelantos.descontado: pagar_sueldo marca true (línea 139 de
--      migration 202605112000). Al anular, quedaban "consumidos" para siempre
--      → próximo pago no incluía los adelantos.
--   2. rrhh_empleados.aguinaldo_acumulado: pagar_sueldo suma total/12.0 al
--      cerrar pago completo (línea 144). Al anular, quedaba inflado → próximo
--      aguinaldo/liquidación final paga de más.
--   3. Pago dividido en múltiples cuentas (varios movimientos para una sola
--      liquidación): anular UN movimiento marcaba la liq entera anulada
--      aunque otros movimientos siguieran activos. Bug latente que se
--      manifestaría con un pago partido.
--
-- Decisión de diseño: NO crear RPC nueva. anular_movimiento sigue siendo el
-- único punto de entrada para anular cualquier movimiento (incluyendo pagos
-- de sueldo). Cuando el movimiento tiene liquidacion_id != NULL, la RPC
-- ahora hace el trabajo extra correctamente.
--
-- Lógica nueva:
--   • Si quedan otros movimientos activos para la misma liq tras la
--     anulación: solo restar el importe a pagos_realizados (NO marcar la liq
--     anulada). Cubre el caso de pago partido.
--   • Si era el último movimiento activo: revertir TODO. Marca la liq
--     anulada + pagos_realizados=0 + estado='pendiente'. Revierte adelantos
--     consumidos (rrhh_adelantos.liquidacion_consumidora_id = p_liq) y
--     aguinaldo (solo si la liq estaba en estado='pagado', porque ese era
--     el único caso donde pagar_sueldo había sumado).
--
-- Para poder revertir adelantos hace falta saber CUÁLES adelantos consumió
-- cada liq. Agregamos columna rrhh_adelantos.liquidacion_consumidora_id que
-- pagar_sueldo va a setear al marcar descontado.
--
-- DEUDA HISTÓRICA: los adelantos ya marcados descontado=true ANTES de esta
-- migration NO tienen liquidacion_consumidora_id (no podemos inferirlo
-- retroactivamente). Si alguien anula un pago histórico, esos adelantos no
-- se reversarán. Aceptado: bajo impacto, el caso es raro y el dueño puede
-- toquetear manualmente si pasa.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Columna nueva en rrhh_adelantos ─────────────────────────────────────
ALTER TABLE rrhh_adelantos
  ADD COLUMN IF NOT EXISTS liquidacion_consumidora_id uuid REFERENCES rrhh_liquidaciones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rrhh_adelantos_liq_consumidora
  ON rrhh_adelantos(liquidacion_consumidora_id)
  WHERE liquidacion_consumidora_id IS NOT NULL;

-- ─── 2. pagar_sueldo: setear liquidacion_consumidora_id al marcar descontado
-- Identical a 202605112000 excepto el bloque UPDATE rrhh_adelantos (líneas
-- 138-140 originales). Mantengo la signatura, la idempotency y todo lo demás.
CREATE OR REPLACE FUNCTION pagar_sueldo(
  p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[],
  p_fecha date, p_mes integer, p_anio integer,
  p_crear_liq boolean DEFAULT false, p_calc jsonb DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_emp RECORD; v_liq RECORD; v_fp jsonb; v_monto numeric; v_cuenta text;
  v_asignado_cash numeric := 0; v_total_adelantos numeric := 0;
  v_total_a_pagar numeric; v_ya_pagado numeric; v_pendiente numeric;
  v_asignado_total numeric; v_completa boolean; v_nuevos_pagos numeric;
  v_mov_ids text[] := ARRAY[]::text[]; v_mov_id text; v_desc text;
  v_meses_nombre text[] := ARRAY['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  v_tenant uuid;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'pagar_sueldo' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay', true); END IF;
  END IF;

  IF p_nov_id IS NULL THEN RAISE EXCEPTION 'NOVEDAD_INVALIDA'; END IF;

  SELECT e.* INTO v_emp FROM rrhh_empleados e
    JOIN rrhh_novedades n ON n.empleado_id = e.id
   WHERE n.id = p_nov_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  PERFORM _validar_local_autorizado(v_emp.local_id);
  v_tenant := v_emp.tenant_id;

  SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
  IF v_liq IS NULL THEN
    IF NOT p_crear_liq OR p_calc IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
    INSERT INTO rrhh_liquidaciones (
      novedad_id, sueldo_base, descuento_ausencias, total_horas_extras,
      total_dobles, total_feriados, total_vacaciones, subtotal1,
      monto_presentismo, subtotal2, adelantos, pagos_realizados,
      total_a_pagar, efectivo, transferencia, estado, calculado_at, tenant_id
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
      'pendiente', now(), v_tenant
    ) RETURNING * INTO v_liq;
  END IF;

  IF v_liq.anulado IS TRUE THEN RAISE EXCEPTION 'LIQUIDACION_ANULADA'; END IF;
  IF v_liq.estado = 'pagado' THEN RAISE EXCEPTION 'LIQUIDACION_YA_PAGADA'; END IF;

  v_total_a_pagar := ROUND(COALESCE(v_liq.total_a_pagar, 0));
  v_ya_pagado := ROUND(COALESCE(v_liq.pagos_realizados, 0));
  v_pendiente := GREATEST(0, v_total_a_pagar - v_ya_pagado);

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    SELECT COALESCE(SUM(monto), 0) INTO v_total_adelantos FROM rrhh_adelantos
     WHERE id = ANY(p_adelantos_ids) AND descontado = false;
  END IF;
  v_total_adelantos := ROUND(v_total_adelantos);

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_asignado_cash := v_asignado_cash + v_monto;
  END LOOP;

  v_asignado_total := v_asignado_cash + v_total_adelantos;
  IF v_asignado_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF v_asignado_total > v_pendiente THEN RAISE EXCEPTION 'MONTO_EXCEDE_PENDIENTE'; END IF;

  v_completa := v_asignado_total >= v_pendiente;
  v_nuevos_pagos := v_ya_pagado + v_asignado_total;
  v_desc := CASE
    WHEN v_completa AND v_ya_pagado = 0 THEN 'Sueldo'
    WHEN v_completa THEN 'Sueldo (saldo final)'
    ELSE 'Sueldo (parcial)'
  END || ' ' || v_emp.apellido || ' ' || v_emp.nombre
    || ' - ' || v_meses_nombre[p_mes+1] || ' ' || p_anio;

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_cuenta := v_fp->>'cuenta';
    IF v_cuenta IS NULL OR v_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

    IF v_emp.local_id IS NOT NULL THEN
      PERFORM _actualizar_saldo_caja(v_cuenta, v_emp.local_id, -v_monto);
    END IF;
    v_mov_id := _gen_id('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, liquidacion_id, tenant_id)
    VALUES (v_mov_id, p_fecha, v_cuenta, 'Pago Sueldo', 'SUELDOS',
      -v_monto, v_desc, v_emp.local_id, v_liq.id, v_tenant);
    v_mov_ids := array_append(v_mov_ids, v_mov_id);
  END LOOP;

  UPDATE rrhh_liquidaciones
     SET pagos_realizados = v_nuevos_pagos,
         estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
         pagado_at = CASE WHEN v_completa THEN now() ELSE pagado_at END,
         pagado_por = CASE WHEN v_completa THEN auth_usuario_id()::text ELSE pagado_por END
   WHERE id = v_liq.id;

  -- ★ CAMBIO 2026-05-14: además de marcar descontado=true, asociar el
  -- adelanto a la liquidación que lo consumió. Permite revertir
  -- correctamente al anular el pago (anular_movimiento).
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
    'completa', v_completa, 'mov_ids', v_mov_ids,
    'adelantos_ids', p_adelantos_ids, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  v_result := jsonb_build_object(
    'liquidacion_id', v_liq.id,
    'mov_ids', v_mov_ids,
    'completa', v_completa,
    'pagos_realizados', v_nuevos_pagos,
    'pendiente', GREATEST(0, v_total_a_pagar - v_nuevos_pagos)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('pagar_sueldo', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- ─── 3. anular_movimiento: lógica completa para revertir liq de sueldo ──────
-- Cuando un movimiento tiene liquidacion_id != NULL:
--   • Si era el ÚLTIMO movimiento activo de la liq:
--       - Si la liq estaba en estado='pagado' (era pago completo), revertir
--         el aguinaldo sumado: total_a_pagar / 12.0
--       - Revertir adelantos consumidos (liquidacion_consumidora_id = liq.id)
--       - Marcar la liq anulada + pagos_realizados=0 + estado='pendiente'
--   • Si quedan otros movimientos activos: solo restar el importe del
--     movimiento a pagos_realizados (NO marcar la liq anulada).
CREATE OR REPLACE FUNCTION anular_movimiento(
  p_mov_id text,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_mov RECORD;
  v_liq RECORD;
  v_emp_id uuid;
  v_movs_restantes integer;
  v_delta_aguinaldo numeric;
  v_gasto_id text;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- Revertir saldo de caja
  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  -- Si el movimiento estaba asociado a una liquidación de sueldo: lógica completa.
  IF v_mov.liquidacion_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = v_mov.liquidacion_id;

    -- Cuántos movimientos activos quedan para esta liq tras esta anulación.
    SELECT COUNT(*) INTO v_movs_restantes
      FROM movimientos
     WHERE liquidacion_id = v_mov.liquidacion_id AND anulado IS NOT TRUE;

    IF v_movs_restantes = 0 THEN
      -- Era el último: revertir TODO.

      -- Aguinaldo: solo si la liq estaba en estado='pagado' (pago completo)
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

      -- Adelantos asociados a esta liq: revertir descontado y limpiar el link.
      UPDATE rrhh_adelantos
         SET descontado = false,
             liquidacion_consumidora_id = NULL
       WHERE liquidacion_consumidora_id = v_mov.liquidacion_id;

      -- Liquidación: anulada y vuelta a estado pre-pago.
      UPDATE rrhh_liquidaciones
         SET anulado = true,
             pagos_realizados = 0,
             estado = 'pendiente',
             pagado_at = NULL,
             pagado_por = NULL
       WHERE id = v_mov.liquidacion_id;
    ELSE
      -- Quedan otros movimientos activos: solo bajar pagos_realizados.
      -- NO marcar la liq anulada (el pago dividido sigue parcialmente vivo).
      UPDATE rrhh_liquidaciones
         SET pagos_realizados = GREATEST(0, COALESCE(pagos_realizados, 0) - ABS(COALESCE(v_mov.importe, 0)))
       WHERE id = v_mov.liquidacion_id;
    END IF;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
    -- Fallback histórico: liquidaciones viejas sin liquidacion_id, match por
    -- (detalle+fecha+cuenta+local_id) contra gastos. Comportamiento idéntico
    -- al de la migration original 20260423 — no agregamos reversión completa
    -- porque para datos legacy faltan los links.
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
    'movimiento', to_jsonb(v_mov), 'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$$;
