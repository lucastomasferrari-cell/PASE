-- ═══════════════════════════════════════════════════════════════════════════
-- Forma de pago por empleado: MENSUAL / QUINCENAL / SEMANAL
--
-- Lucas 2026-05-19: hay empleados que cobran cada 15 días o cada semana
-- (típico en gastronomía con personal nuevo o categorías auxiliares). Hasta
-- ahora todos cobraban mensual. Implementamos Opción A:
--
--   • Forma de pago es CONDICIÓN CONTRACTUAL del empleado (no por novedad).
--     Vive en rrhh_empleados.modo_pago.
--   • La novedad sigue siendo mensual (un período = un mes).
--   • Al confirmar la novedad, en vez de generar 1 fila en rrhh_liquidaciones
--     con el total del mes, generamos N filas (cuotas), donde N depende del
--     modo_pago: MENSUAL=1, QUINCENAL=2, SEMANAL=4.
--   • Cada cuota tiene su total_a_pagar = total_mes / N + su fecha_vencimiento.
--   • pagar_sueldo paga UNA cuota por vez (acepta p_liq_id para identificar
--     cuál cuota se está pagando).
--
-- Backward compat: empleados existentes quedan MENSUAL (default), liquidaciones
-- existentes tienen cuota_num=1 / cuotas_total=1 (defaults). Sin cambios de
-- comportamiento para el flujo actual.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. modo_pago en empleados ──────────────────────────────────────────────
ALTER TABLE rrhh_empleados
  ADD COLUMN IF NOT EXISTS modo_pago TEXT NOT NULL DEFAULT 'MENSUAL';

DO $$
BEGIN
  -- Constraint con IF NOT EXISTS no existe en ALTER TABLE ADD CONSTRAINT,
  -- usamos check programático. Drop+recreate si existe (idempotente).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rrhh_empleados_modo_pago_check'
       AND conrelid = 'rrhh_empleados'::regclass
  ) THEN
    ALTER TABLE rrhh_empleados DROP CONSTRAINT rrhh_empleados_modo_pago_check;
  END IF;
  ALTER TABLE rrhh_empleados
    ADD CONSTRAINT rrhh_empleados_modo_pago_check
    CHECK (modo_pago IN ('MENSUAL','QUINCENAL','SEMANAL'));
END $$;

-- ─── 2. cuota_num + cuotas_total + fecha_vencimiento en liquidaciones ─────
ALTER TABLE rrhh_liquidaciones
  ADD COLUMN IF NOT EXISTS cuota_num INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cuotas_total INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rrhh_liquidaciones_cuota_num_check'
       AND conrelid = 'rrhh_liquidaciones'::regclass
  ) THEN
    ALTER TABLE rrhh_liquidaciones DROP CONSTRAINT rrhh_liquidaciones_cuota_num_check;
  END IF;
  ALTER TABLE rrhh_liquidaciones
    ADD CONSTRAINT rrhh_liquidaciones_cuota_num_check
    CHECK (cuota_num >= 1 AND cuota_num <= 4);

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rrhh_liquidaciones_cuotas_total_check'
       AND conrelid = 'rrhh_liquidaciones'::regclass
  ) THEN
    ALTER TABLE rrhh_liquidaciones DROP CONSTRAINT rrhh_liquidaciones_cuotas_total_check;
  END IF;
  ALTER TABLE rrhh_liquidaciones
    ADD CONSTRAINT rrhh_liquidaciones_cuotas_total_check
    CHECK (cuotas_total IN (1, 2, 4));
END $$;

-- ─── 3. Reemplazar UNIQUE(novedad_id) por UNIQUE(novedad_id, cuota_num) ────
-- Encuentra el constraint UNIQUE actual sobre solo novedad_id y lo dropea.
DO $$
DECLARE
  v_constraint TEXT;
  v_attnum SMALLINT;
BEGIN
  SELECT attnum INTO v_attnum
    FROM pg_attribute
   WHERE attrelid = 'rrhh_liquidaciones'::regclass
     AND attname = 'novedad_id';

  SELECT conname INTO v_constraint
    FROM pg_constraint
   WHERE conrelid = 'rrhh_liquidaciones'::regclass
     AND contype = 'u'
     AND array_length(conkey, 1) = 1
     AND conkey[1] = v_attnum;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE rrhh_liquidaciones DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rrhh_liquidaciones_novedad_cuota_unique'
       AND conrelid = 'rrhh_liquidaciones'::regclass
  ) THEN
    ALTER TABLE rrhh_liquidaciones
      ADD CONSTRAINT rrhh_liquidaciones_novedad_cuota_unique UNIQUE (novedad_id, cuota_num);
  END IF;
END $$;

-- ─── 4. RPC pagar_sueldo con p_liq_id opcional ─────────────────────────────
-- DROP necesario porque cambia la signature (parámetro nuevo). Sin drop,
-- PostgREST puede resolver mal la sobrecarga (incidente similar al de
-- anular_movimiento 2026-05-18).
DROP FUNCTION IF EXISTS pagar_sueldo(uuid, jsonb, uuid[], date, integer, integer, boolean, jsonb, text);

CREATE OR REPLACE FUNCTION pagar_sueldo(
  p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[],
  p_fecha date, p_mes integer, p_anio integer,
  p_crear_liq boolean DEFAULT false, p_calc jsonb DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_liq_id uuid DEFAULT NULL
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
  v_count_liqs integer;
  v_cuota_label text;
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

  -- Lookup de la liquidación: 3 modos
  --   (A) p_liq_id explícito → cargar esa cuota específica (modo cuotas).
  --   (B) p_liq_id NULL pero p_crear_liq=true + p_calc → crear cuota única.
  --   (C) p_liq_id NULL sin p_crear_liq → buscar por novedad_id, exige 1 sola.
  IF p_liq_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = p_liq_id;
    IF v_liq IS NULL THEN RAISE EXCEPTION 'LIQUIDACION_NO_ENCONTRADA'; END IF;
    IF v_liq.novedad_id IS DISTINCT FROM p_nov_id THEN
      RAISE EXCEPTION 'LIQUIDACION_NOVEDAD_MISMATCH';
    END IF;
  ELSE
    SELECT COUNT(*) INTO v_count_liqs FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
    IF v_count_liqs > 1 THEN
      -- Tenía varias cuotas y el caller no especificó cuál → error claro
      -- para que la UI mande p_liq_id explícito.
      RAISE EXCEPTION 'MULTIPLES_CUOTAS_REQUIERE_LIQ_ID';
    END IF;
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE novedad_id = p_nov_id;
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

  -- Label del movimiento: si es multi-cuota, dejar claro qué cuota es.
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
    || v_cuota_label;

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

  IF p_adelantos_ids IS NOT NULL AND array_length(p_adelantos_ids, 1) > 0 THEN
    UPDATE rrhh_adelantos
       SET descontado = true,
           liquidacion_consumidora_id = v_liq.id
     WHERE id = ANY(p_adelantos_ids);
  END IF;

  -- Aguinaldo: total_a_pagar / 12. Para cuotas, cada pago agrega su slice
  -- (total_cuota / 12). La suma de N cuotas = total_mes / 12. Mismo resultado
  -- neto que el modo mensual.
  IF v_completa THEN
    UPDATE rrhh_empleados
       SET aguinaldo_acumulado = COALESCE(aguinaldo_acumulado, 0) + v_total_a_pagar / 12.0
     WHERE id = v_emp.id;
  END IF;

  PERFORM _auditar('rrhh_liquidaciones', 'PAGO', jsonb_build_object(
    'liquidacion_id', v_liq.id, 'monto_asignado', v_asignado_total,
    'completa', v_completa, 'mov_ids', v_mov_ids,
    'cuota_num', v_liq.cuota_num, 'cuotas_total', v_liq.cuotas_total,
    'adelantos_ids', p_adelantos_ids, 'usuario_id', auth_usuario_id()
  ), v_tenant);

  v_result := jsonb_build_object(
    'liquidacion_id', v_liq.id,
    'mov_ids', v_mov_ids,
    'completa', v_completa,
    'pagos_realizados', v_nuevos_pagos,
    'pendiente', GREATEST(0, v_total_a_pagar - v_nuevos_pagos),
    'cuota_num', v_liq.cuota_num,
    'cuotas_total', v_liq.cuotas_total
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('pagar_sueldo', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION pagar_sueldo(uuid, jsonb, uuid[], date, integer, integer, boolean, jsonb, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION pagar_sueldo(uuid, jsonb, uuid[], date, integer, integer, boolean, jsonb, text, uuid) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
