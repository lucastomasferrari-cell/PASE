-- 202606130410_fix_aguinaldo_bruto_pagar_sueldo.sql
--
-- FIX de regresión de la 202606130400: al portar pagar_sueldo para el recálculo
-- server-side se tomó como base la 202606072100 (aguinaldo sobre el NETO) en vez
-- de la VIGENTE 202606072300 (aguinaldo sobre el BRUTO/subtotal2). anular_movimiento
-- (202606100500) revierte sobre el bruto → asimetría de adelanto/12 por pago con
-- adelanto (caza-do por anular_pago_sueldo_mutante.spec.ts: dif 50000/12=4166.67).
-- Único cambio vs 130400: la línea del aguinaldo (ver más abajo). Se recrea la
-- función entera (no se puede patchear una línea de una función plpgsql); el
-- CREATE OR REPLACE de fn_liquidacion_total_canonico es idéntico (no-op inofensivo).
--
-- ─── (header original de 130400 conservado para contexto) ───────────────────
-- Tier 2 (ítem 8 del informe ejecutivo / RRHH report #04 §2.3 hallazgo #2):
-- VALIDACIÓN SERVER-SIDE de pagar_sueldo.
--
-- PROBLEMA: hoy `pagar_sueldo` recibe el desglose YA calculado por el navegador
-- (`p_calc`) y lo guarda tal cual. Un bug de JS escribe plata mal en silencio, y
-- con multi-tenant cualquier usuario autenticado puede llamar la RPC con números
-- inventados (tamper).
--
-- FIX: la RPC recalcula el total canónico server-side desde la novedad + sueldo
-- vigente + adelantos tildados (`fn_liquidacion_total_canonico`), RECHAZA si el
-- `total_a_pagar` que mandó el cliente difiere más de la tolerancia (±$1) con
-- `LIQUIDACION_CALCULO_INCONSISTENTE`, y ALMACENA los componentes recalculados
-- (no los del cliente). El servidor pasa a ser la fuente de verdad.
--
-- ALCANCE: SOLO pagar_sueldo (pago mensual/quincenal, determinístico). FUERA:
-- liquidacion_final_empleado / pagar_aguinaldo / pagar_vacaciones (líneas
-- editables por el humano, sin total canónico).
--
-- ─── ESPEJO EXACTO de packages/pase/src/lib/calculos/rrhh.ts ────────────────
-- La fórmula canónica refleja EXACTAMENTE el camino que recorre el cliente en
-- TabSueldos.tsx::calcularDesglose → calcularTotalLiquidacion. Diferencias clave
-- respecto del borrador del plan, resueltas leyendo la fuente TS REAL:
--   1. modo_pago: TabSueldos deriva `cuotasTotal===2 ? QUINCENAL : MENSUAL`
--      (NUNCA SEMANAL). calcularSueldoBase: QUINCENAL → sueldo/2, else → sueldo.
--      Por eso acá: cuotas_total=2 → /2, cualquier otro valor → sueldo entero
--      (cuotas_total=4 desde esta UI cae en MENSUAL, NO /4).
--   2. valor_doble = emp.sueldo_mensual / 30 (TabSueldos lo fija así; la fórmula
--      hace max(0,dobles)*max(0,valor_doble)).
--   3. total_vacaciones = max(0,vacaciones_dias) * (sueldo/25 - sueldo/30)
--      (PLUS vacacional, no el día completo).
--   4. presentismo "mantiene" = presentismo IS DISTINCT FROM 'PIERDE'
--      (TabSueldos: presentismo_mantiene = n.presentismo !== "PIERDE", así que
--      NULL / 'MANTIENE' / 'PIERDE_LLEGADAS' / 'INICIO_PARCIAL' → mantiene=true;
--      SOLO 'PIERDE' → false). El borrador del plan usaba `= 'MANTIENE'` (mal).
--   5. presentismo = sueldo_mensual * 0.05 (sobre el sueldo MENSUAL completo),
--      0 si Q1 quincenal (cuotas_total=2 AND cuota_num=1).
--   6. pagos_dobles_realizados: TabSueldos SIEMPRE pasa 0 → acá es 0 (NO se lee
--      de la columna rrhh_novedades.pagos_dobles_realizados, para no diverger
--      del cliente). Entra al total como `- max(0, 0)` = sin efecto, pero se
--      respeta la estructura de la fórmula.
--   7. adelantos = SUM(monto) de rrhh_adelantos WHERE id = ANY(ids) — columna
--      `monto` (NO `importe`, que no existe), sin filtro `descontado` (el cliente
--      suma los tildados sin filtrar, hay que espejar eso para que el total
--      coincida).
--   8. componentes redondeados con round() — el cliente los manda ya
--      Math.round-eados desde calcularDesglose, así se guarda igual formato.
--   9. total_a_pagar = round(subtotal2 + bono - adelantos - pagos_dobles - otros)
--      y LUEGO max(0, ...) — el cliente muestra Math.max(0, r.total_a_pagar) y
--      ese es el `total` que viaja en p_calc.total_a_pagar; por eso clampeamos a 0.
--      (En rrhh.ts el round NO clampea, pero calcularDesglose.total SÍ → es lo
--       que el cliente envía.)
--
-- DRIFT: la fórmula vive ahora en DOS lugares (TS + SQL). El test mutante
-- SQL==TS (Task 3) es el juez final; si alguien toca uno, lo caza en CI.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_liquidacion_total_canonico — espejo server-side de calcularTotalLiquidacion
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_liquidacion_total_canonico(
  p_nov_id uuid,
  p_adelantos_ids uuid[]
) RETURNS jsonb
-- SECURITY INVOKER (no DEFINER): solo lee rrhh_novedades/empleados/adelantos,
-- todas con RLS que ya scopea por tenant/locales del caller. Evita el leak
-- cross-tenant que tendría un DEFINER sin auth-check (C11) y es suficiente
-- porque pagar_sueldo (su único caller productivo) ya validó tenant+local antes.
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $fn$
DECLARE
  v_nov RECORD;
  v_sueldo numeric;
  v_cuotas int;
  v_cuota int;
  v_modo_quincenal boolean;
  v_sueldo_base numeric;
  v_valor_dia numeric;
  v_valor_hora numeric;
  v_valor_doble numeric;
  v_plus_vac_dia numeric;
  v_desc_aus numeric;
  v_extras numeric;
  v_dobles numeric;
  v_feriados numeric;
  v_vac numeric;
  v_subtotal1 numeric;
  v_present_aplica boolean;
  v_present numeric;
  v_subtotal2 numeric;
  v_adelantos numeric;
  v_pagos_dobles numeric := 0;  -- TabSueldos siempre pasa 0
  v_otros numeric;
  v_bono numeric;
  v_total numeric;
BEGIN
  SELECT n.inasistencias, n.horas_extras, n.dobles, n.feriados,
         n.vacaciones_dias, n.presentismo, n.otros_descuentos, n.bono,
         n.cuota_num, n.cuotas_total, e.sueldo_mensual
    INTO v_nov
    FROM rrhh_novedades n
    JOIN rrhh_empleados e ON e.id = n.empleado_id
   WHERE n.id = p_nov_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOVEDAD_NO_ENCONTRADA'; END IF;

  v_sueldo := COALESCE(v_nov.sueldo_mensual, 0);
  v_cuotas := COALESCE(v_nov.cuotas_total, 1);
  v_cuota  := COALESCE(v_nov.cuota_num, 1);

  -- modo_pago: TabSueldos → cuotasTotal===2 ? QUINCENAL : MENSUAL.
  -- calcularSueldoBase: QUINCENAL → /2, MENSUAL → entero (NUNCA /4 desde esta UI).
  v_modo_quincenal := (v_cuotas = 2);
  v_sueldo_base := CASE WHEN v_modo_quincenal THEN v_sueldo / 2.0 ELSE v_sueldo END;

  v_valor_dia   := v_sueldo / 30.0;
  v_valor_hora  := v_sueldo / 30.0 / 8.0;
  v_valor_doble := v_sueldo / 30.0;                      -- TabSueldos: sueldo/30
  v_plus_vac_dia := (v_sueldo / 25.0) - (v_sueldo / 30.0); -- plus vacacional/día

  -- calcularDescuentoAusencias: si inasistencias<=0 o sueldo<=0 → 0.
  v_desc_aus := CASE WHEN COALESCE(v_nov.inasistencias,0) <= 0 OR v_sueldo <= 0
                     THEN 0 ELSE COALESCE(v_nov.inasistencias,0) * v_valor_dia END;
  -- calcularHorasExtras: si horas=0 o sueldo<=0 → 0. PUEDE ser NEGATIVO.
  v_extras   := CASE WHEN COALESCE(v_nov.horas_extras,0) = 0 OR v_sueldo <= 0
                     THEN 0 ELSE COALESCE(v_nov.horas_extras,0) * v_valor_hora END;
  v_dobles   := GREATEST(0, COALESCE(v_nov.dobles,0)) * GREATEST(0, v_valor_doble);
  v_feriados := GREATEST(0, COALESCE(v_nov.feriados,0)) * v_valor_dia;
  v_vac      := GREATEST(0, COALESCE(v_nov.vacaciones_dias,0)) * v_plus_vac_dia;

  v_subtotal1 := v_sueldo_base - v_desc_aus + v_extras + v_dobles + v_feriados + v_vac;

  -- presentismo: 0 en Q1 quincenal (diferido a Q2); si no, 5% del sueldo mensual
  -- cuando mantiene. mantiene = presentismo IS DISTINCT FROM 'PIERDE'.
  v_present_aplica := NOT (v_cuotas = 2 AND v_cuota = 1);
  v_present := CASE
    WHEN NOT v_present_aplica THEN 0
    WHEN v_sueldo <= 0 THEN 0
    WHEN v_nov.presentismo IS DISTINCT FROM 'PIERDE' THEN v_sueldo * 0.05
    ELSE 0
  END;

  v_subtotal2 := v_subtotal1 + v_present;

  -- adelantos tildados: SUM(monto) de los ids pasados (espejo del cliente,
  -- que suma los tildados sin filtrar por descontado).
  SELECT COALESCE(SUM(monto), 0) INTO v_adelantos
    FROM rrhh_adelantos
   WHERE id = ANY(COALESCE(p_adelantos_ids, ARRAY[]::uuid[]));

  v_otros := GREATEST(0, COALESCE(v_nov.otros_descuentos, 0));
  v_bono  := GREATEST(0, COALESCE(v_nov.bono, 0));

  -- total_a_pagar = round(subtotal2 + bono - max(0,adel) - max(0,pagos_dobles) - max(0,otros))
  -- y luego max(0, ...) (el cliente muestra/envía Math.max(0, total)).
  v_total := GREATEST(0, round(
    v_subtotal2
    + v_bono
    - GREATEST(0, v_adelantos)
    - GREATEST(0, v_pagos_dobles)
    - v_otros
  ));

  RETURN jsonb_build_object(
    'sueldo_base',         round(v_sueldo_base),
    'descuento_ausencias', round(v_desc_aus),
    'total_horas_extras',  round(v_extras),
    'total_dobles',        round(v_dobles),
    'total_feriados',      round(v_feriados),
    'total_vacaciones',    round(v_vac),
    'subtotal1',           round(v_subtotal1),
    'monto_presentismo',   round(v_present),
    'subtotal2',           round(v_subtotal2),
    'adelantos',           round(GREATEST(0, v_adelantos)),
    'otros_descuentos',    round(v_otros),
    'bono',                round(v_bono),
    'total_a_pagar',       v_total
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_liquidacion_total_canonico(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_liquidacion_total_canonico(uuid, uuid[]) TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- pagar_sueldo v2 — misma firma, recálculo + validación + guarda canónico
--
-- Copia ÍNTEGRA de 202606072100 con DOS cambios:
--   (A) bloque de recálculo canónico + validación LIQUIDACION_CALCULO_INCONSISTENTE
--       (después del check de idempotencia / empleado, antes de insertar/revivir).
--   (B) los INSERT/UPDATE de rrhh_liquidaciones leen de v_canon (NO de p_calc).
-- Todo lo demás (idempotencia, revivir-anulada, formas_pago→movimientos,
-- adelantos descontado, aguinaldo_acumulado += total/12, multi-cuenta, sin-capeo
-- de pagos_realizados) queda IDÉNTICO.
--
-- NOTA: 202606100300 dejó esta función como SECURITY INVOKER (falso positivo H3
-- resuelto: pagar_sueldo DEBE ser INVOKER). Se preserva ese atributo abajo.
-- ═══════════════════════════════════════════════════════════════════════════
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
  -- ★ Recálculo canónico server-side (anti-bug del front + anti-tamper multi-tenant)
  v_canon jsonb;
  v_canon_total numeric;
  v_cliente_total numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

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

  -- ─── ★ Recálculo canónico server-side ──────────────────────────────────────
  -- El servidor recalcula el total desde la novedad + sueldo vigente + adelantos
  -- tildados. Si el cliente mandó p_calc, se valida que su total_a_pagar coincida
  -- (±$1). A partir de acá, los componentes que se GUARDAN salen de v_canon, NO
  -- de p_calc (p_calc queda solo como input a validar — compat de firma).
  v_canon := fn_liquidacion_total_canonico(p_nov_id, p_adelantos_ids);
  v_canon_total := (v_canon->>'total_a_pagar')::numeric;
  IF p_calc IS NOT NULL THEN
    v_cliente_total := (p_calc->>'total_a_pagar')::numeric;
    IF abs(COALESCE(v_cliente_total, -1) - v_canon_total) > 1 THEN
      RAISE EXCEPTION 'LIQUIDACION_CALCULO_INCONSISTENTE: cliente=% server=%', v_cliente_total, v_canon_total;
    END IF;
  END IF;

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
      -- p_crear_liq requiere que el caller haya mandado p_calc (señal de intención
      -- de crear). Pero los componentes guardados salen de v_canon (server-authoritative).
      IF NOT p_crear_liq OR p_calc IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
      INSERT INTO rrhh_liquidaciones (
        novedad_id, sueldo_base, descuento_ausencias, total_horas_extras,
        total_dobles, total_feriados, total_vacaciones, subtotal1,
        monto_presentismo, subtotal2, adelantos, pagos_realizados,
        total_a_pagar, efectivo, transferencia, estado, calculado_at, tenant_id,
        cuota_num, cuotas_total
      ) VALUES (
        p_nov_id,
        (v_canon->>'sueldo_base')::numeric, (v_canon->>'descuento_ausencias')::numeric,
        (v_canon->>'total_horas_extras')::numeric, (v_canon->>'total_dobles')::numeric,
        (v_canon->>'total_feriados')::numeric, COALESCE((v_canon->>'total_vacaciones')::numeric, 0),
        (v_canon->>'subtotal1')::numeric, (v_canon->>'monto_presentismo')::numeric,
        (v_canon->>'subtotal2')::numeric, COALESCE((v_canon->>'adelantos')::numeric, 0),
        0, (v_canon->>'total_a_pagar')::numeric,
        COALESCE((p_calc->>'efectivo')::numeric, 0),
        COALESCE((p_calc->>'transferencia')::numeric, 0),
        'pendiente', now(), v_tenant,
        COALESCE((SELECT cuota_num   FROM rrhh_novedades WHERE id = p_nov_id), 1),
        COALESCE((SELECT cuotas_total FROM rrhh_novedades WHERE id = p_nov_id), 1)
      ) RETURNING * INTO v_liq;
    END IF;
  END IF;

  IF v_liq.anulado IS TRUE THEN
    -- Revivir una liquidación anulada requiere p_calc (intención de re-pagar);
    -- los componentes resucitados salen de v_canon (server-authoritative).
    IF p_calc IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_ANULADA'; END IF;
    UPDATE rrhh_liquidaciones SET
      anulado = false,
      estado = 'pendiente',
      pagos_realizados = 0,
      pagado_at = NULL,
      pagado_por = NULL,
      sueldo_base = (v_canon->>'sueldo_base')::numeric,
      descuento_ausencias = (v_canon->>'descuento_ausencias')::numeric,
      total_horas_extras = (v_canon->>'total_horas_extras')::numeric,
      total_dobles = (v_canon->>'total_dobles')::numeric,
      total_feriados = (v_canon->>'total_feriados')::numeric,
      total_vacaciones = COALESCE((v_canon->>'total_vacaciones')::numeric, 0),
      subtotal1 = (v_canon->>'subtotal1')::numeric,
      monto_presentismo = (v_canon->>'monto_presentismo')::numeric,
      subtotal2 = (v_canon->>'subtotal2')::numeric,
      adelantos = COALESCE((v_canon->>'adelantos')::numeric, 0),
      total_a_pagar = (v_canon->>'total_a_pagar')::numeric,
      efectivo = COALESCE((p_calc->>'efectivo')::numeric, 0),
      transferencia = COALESCE((p_calc->>'transferencia')::numeric, 0),
      calculado_at = now()
    WHERE id = v_liq.id
    RETURNING * INTO v_liq;
  END IF;

  IF v_liq.estado = 'pagado' THEN RAISE EXCEPTION 'LIQUIDACION_YA_PAGADA'; END IF;

  v_total_a_pagar := ROUND(COALESCE(v_liq.total_a_pagar, 0));
  v_ya_pagado := ROUND(COALESCE(v_liq.pagos_realizados, 0));
  v_pendiente := GREATEST(0, v_total_a_pagar - v_ya_pagado);

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    PERFORM 1 FROM rrhh_adelantos
     WHERE id = ANY(p_adelantos_ids) AND descontado = false FOR UPDATE;
    SELECT COALESCE(SUM(monto), 0) INTO v_total_adelantos FROM rrhh_adelantos
     WHERE id = ANY(p_adelantos_ids) AND descontado = false;
  END IF;
  v_total_adelantos := ROUND(v_total_adelantos);

  FOR v_fp IN SELECT * FROM jsonb_array_elements(COALESCE(p_formas_pago, '[]'::jsonb)) LOOP
    v_monto := COALESCE((v_fp->>'monto')::numeric, 0);
    IF v_monto <= 0 THEN CONTINUE; END IF;
    v_asignado_cash := v_asignado_cash + v_monto;
  END LOOP;

  -- ★ FIX 07-jun (caso Esteban): el adelanto NO cuenta como pago. Ya está
  -- restado de total_a_pagar (neto). pagos_realizados = solo efectivo/transfer,
  -- alineado con el trigger _resync_liquidacion_pagos. El adelanto solo se
  -- marca descontado=true más abajo.
  v_asignado_total := v_asignado_cash;
  IF v_asignado_cash <= 0 AND v_total_adelantos <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  v_completa := v_asignado_total >= v_pendiente;
  v_sobrepago := GREATEST(0, v_asignado_total - v_pendiente);
  v_nuevos_pagos := v_ya_pagado + v_asignado_total;

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

  UPDATE rrhh_liquidaciones
     SET pagos_realizados = v_nuevos_pagos,
         estado = CASE WHEN v_completa THEN 'pagado' ELSE estado END,
         pagado_at = CASE
           WHEN v_completa AND pagado_at IS NULL THEN p_fecha::timestamptz
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

  -- Aguinaldo: subtotal2 (BRUTO) / 12, igual que la vigente 202606072300 y que la
  -- reversión de anular_movimiento (202606100500). FIX 202606130410: la 130400
  -- había regresionado a v_total_a_pagar (NETO) / 12 al portar desde 072100,
  -- generando una asimetría de adelanto/12 (caza-do por anular_pago_sueldo_mutante).
  IF v_completa THEN
    UPDATE rrhh_empleados
       SET aguinaldo_acumulado = COALESCE(aguinaldo_acumulado, 0)
             + COALESCE(v_liq.subtotal2, v_total_a_pagar) / 12.0
     WHERE id = v_emp.id;
  END IF;

  PERFORM _auditar('rrhh_liquidaciones', 'PAGO', jsonb_build_object(
    'liquidacion_id', v_liq.id, 'monto_asignado', v_asignado_total,
    'adelantos_aplicados', v_total_adelantos,
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

-- Preservar SECURITY INVOKER (lo dejó así 202606100300 — falso positivo H3
-- resuelto: pagar_sueldo DEBE ser INVOKER). CREATE OR REPLACE no cambia el
-- atributo de seguridad, pero lo reafirmamos explícito para que quede en una
-- sola migración la verdad de cómo debe quedar.
ALTER FUNCTION public.pagar_sueldo(p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[], p_fecha date, p_mes integer, p_anio integer, p_crear_liq boolean, p_calc jsonb, p_idempotency_key text, p_liq_id uuid) SECURITY INVOKER;

NOTIFY pgrst, 'reload schema';

COMMIT;
