-- ════════════════════════════════════════════════════════════════════════
-- Batch de fixes de la re-auditoría 09-jun (hallazgos H1, H3, H4, H5, H6).
-- Ver detalle en packages/pase/docs/audit-2026-06/REPORTE-RE-AUDITORIA-09-JUN.md
--   H1  anular_movimiento: revertía aguinaldo sobre el NETO cuando pagar_sueldo
--       acumula sobre el BRUTO → aguinaldo fantasma en cada pagar→anular con adelanto.
--   H3  ❌ FALSO POSITIVO — pagar_sueldo SÍ debe ser INVOKER: al probarlo como
--       SECURITY DEFINER los mutantes de sueldo fallaron (completa=false).
--       Se aplicó y se REVIRTIÓ en la misma sesión. NO tocar.
--   H4  fn_anular_venta_comanda: rama "venta vacía" sin validación de local/tenant.
--   H5  editar_movimiento_caja: lookup de idempotency_keys sin filtro de tenant.
--   H6  fn_aplicar_stock_venta: NOT EXISTS anti-redescuento evaluado antes del lock.
-- ════════════════════════════════════════════════════════════════════════

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
  v_tenant uuid;
  v_hermanas integer := 0;
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

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;
  v_tenant := v_mov.tenant_id;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- ★ NUEVO 09-jun (sprint anti-huérfanos): si es una pata de transferencia,
  -- anular también la(s) pata(s) hermana(s) para no dejar media transferencia.
  IF v_mov.transferencia_id IS NOT NULL THEN
    UPDATE movimientos
       SET anulado = true,
           anulado_motivo = COALESCE(p_motivo, 'Anulación de la pata hermana de la transferencia')
     WHERE transferencia_id = v_mov.transferencia_id
       AND id <> p_mov_id
       AND COALESCE(anulado, false) = false;
    GET DIAGNOSTICS v_hermanas = ROW_COUNT;
  END IF;

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
          -- AUDIT 09-jun (H1): revertir con la MISMA base que acumula pagar_sueldo
          -- (subtotal2 = bruto, fix 202606072300). Antes restaba total_a_pagar/12
          -- (neto) y cada ciclo pagar→anular dejaba aguinaldo fantasma cuando
          -- había adelantos.
          v_delta_aguinaldo := COALESCE(v_liq.subtotal2, v_liq.total_a_pagar, 0) / 12.0;
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
       WHERE id = v_mov.liquidacion_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'mov_id', p_mov_id,
    'anulado', true,
    'patas_hermanas_anuladas', v_hermanas
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_anular_venta_comanda(p_venta_id bigint, p_manager_id uuid, p_motivo text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_mesa_id BIGINT;
  v_cajero UUID;
  v_existing BIGINT;
  v_items_activos INTEGER;
  v_es_vacia BOOLEAN;
BEGIN
  -- Idempotency: si ya hay override con este key, salir.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Cargar datos de la venta primero (necesarios para decidir si TOTP aplica).
  SELECT local_id, total, mesa_id, cajero_id
    INTO v_local_id, v_total, v_mesa_id, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- Contar items NO anulados de la venta.
  SELECT COUNT(*) INTO v_items_activos
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id
     AND deleted_at IS NULL
     AND estado != 'anulado';

  -- "Vacía" = total 0 + sin items activos. No hay dinero ni consumo.
  v_es_vacia := (COALESCE(v_total, 0) = 0 AND v_items_activos = 0);

  -- AUDIT 09-jun (H4): el caller SIEMPRE debe pertenecer al local de la venta
  -- (la rama "vacía" permitía anular cross-local/tenant con un id enumerable).
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- Si NO es vacía, exigir manager TOTP (regla original — auditoría financiera).
  IF NOT v_es_vacia THEN
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
    ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;
  -- Si ES vacía, no validamos manager — cualquier user autenticado puede anular.

  UPDATE ventas_pos SET estado = 'anulada', anulada_at = NOW(), updated_at = NOW()
   WHERE id = p_venta_id;
  UPDATE ventas_pos_items SET estado = 'anulado', anulado_at = NOW(), updated_at = NOW()
   WHERE venta_id = p_venta_id AND estado != 'anulado';
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Audit: registrar el override. Si fue una anulación de venta vacía sin
  -- manager, manager_id = NULL en el row (queda como "anulada por cajero
  -- sin override por venta vacía"). El motivo describe el caso.
  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id,
    COALESCE(v_cajero, p_manager_id),
    p_manager_id,  -- puede ser NULL si fue venta vacía
    'void',
    CASE WHEN v_es_vacia AND p_manager_id IS NULL
         THEN COALESCE(p_motivo, '') || ' [anulación venta vacía sin TOTP]'
         ELSE p_motivo END,
    COALESCE(v_total, 0),
    p_idempotency_key
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.editar_movimiento_caja(p_mov_id text, p_fecha date, p_detalle text, p_cat text, p_importe numeric, p_cuenta text, p_tipo text, p_justificativo text, p_idempotency_key text DEFAULT NULL::text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_orig RECORD;
  v_cached jsonb;
  v_result jsonb;
  v_cambio_saldo boolean;
BEGIN
  -- ─── 1) Auth: permiso caja_anular O código TOTP válido ──────────────────
  IF NOT auth_tiene_permiso_o_override(
    'caja_anular',
    p_override_code,
    'editar_movimiento_caja',
    jsonb_build_object(
      'mov_id', p_mov_id,
      'importe_nuevo', p_importe,
      'cuenta_nueva', p_cuenta,
      'motivo', p_justificativo
    )
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso caja_anular o código del manager';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  -- ─── 2) Validar input ────────────────────────────────────────────────────
  IF p_mov_id IS NULL OR length(trim(p_mov_id)) = 0 THEN
    RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO';
  END IF;
  IF p_justificativo IS NULL OR length(trim(p_justificativo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;
  IF p_cuenta IS NULL OR length(trim(p_cuenta)) = 0 THEN
    RAISE EXCEPTION 'CUENTA_INVALIDA';
  END IF;

  -- ─── 3) Idempotency check ────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'editar_movimiento_caja' AND key = p_idempotency_key
        -- AUDIT 09-jun (H5): sin este filtro, una colisión de key entre
        -- tenants devolvía el resultado cacheado de OTRO tenant.
        AND tenant_id = auth_tenant_id();
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  -- ─── 4) Cargar original + lock ───────────────────────────────────────────
  SELECT * INTO v_orig FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_orig IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_orig.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;
  IF v_orig.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_orig.local_id);

  -- ─── 5a) BLOQUEO: movimientos derivados de documentos complejos ──────────
  -- (factura, remito, sueldo/liquidación, transferencia, pago especial) no se
  -- pueden re-importar desde Caja: editá/anulá el documento original. Esto
  -- evita el desfasaje entre el movimiento y su documento fuente.
  -- Solo bloquea si efectivamente cambia el importe (fecha/detalle/cuenta sí
  -- se pueden corregir).
  IF (v_orig.importe IS DISTINCT FROM p_importe) AND (
        v_orig.fact_id IS NOT NULL
     OR v_orig.remito_id_ref IS NOT NULL
     OR v_orig.liquidacion_id IS NOT NULL
     OR v_orig.transferencia_id IS NOT NULL
     OR v_orig.pago_especial_id_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MOVIMIENTO_LIGADO_NO_EDITABLE';
  END IF;

  -- ─── 5b) Ajuste de saldos si cambió cuenta o importe ─────────────────────
  v_cambio_saldo := (v_orig.cuenta IS DISTINCT FROM p_cuenta)
                 OR (v_orig.importe IS DISTINCT FROM p_importe);

  IF v_cambio_saldo AND v_orig.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_orig.cuenta, v_orig.local_id, -COALESCE(v_orig.importe, 0));
    PERFORM _actualizar_saldo_caja(p_cuenta, v_orig.local_id, p_importe);
  END IF;

  -- ─── 6) Update del movimiento ────────────────────────────────────────────
  UPDATE movimientos
     SET fecha = p_fecha,
         detalle = p_detalle,
         cat = p_cat,
         importe = p_importe,
         cuenta = p_cuenta,
         tipo = p_tipo,
         editado = true,
         editado_motivo = p_justificativo,
         editado_at = now()
   WHERE id = p_mov_id;

  -- ─── 6b) CASCADA: sincronizar el registro ORIGEN (gasto / adelanto) ──────
  -- El fix del bug: el movimiento es derivado; si cambia su monto/fecha/cuenta,
  -- el gasto/adelanto del que salió debe seguirlo. ABS porque los egresos
  -- guardan importe negativo y el origen guarda monto positivo. Un "Gasto
  -- empleado / Adelanto" tiene AMBOS refs → se actualizan los dos.
  IF v_orig.gasto_id_ref IS NOT NULL THEN
    UPDATE gastos
       SET monto = ABS(p_importe), fecha = p_fecha, cuenta = p_cuenta
     WHERE id = v_orig.gasto_id_ref;
  END IF;
  IF v_orig.adelanto_id_ref IS NOT NULL THEN
    UPDATE rrhh_adelantos
       SET monto = ABS(p_importe), fecha = p_fecha, cuenta = p_cuenta
     WHERE id = v_orig.adelanto_id_ref;
  END IF;

  -- ─── 7) Auditoria ────────────────────────────────────────────────────────
  PERFORM _auditar('movimientos', 'EDICION', jsonb_build_object(
    'mov_id', p_mov_id,
    'antes', to_jsonb(v_orig),
    'despues', jsonb_build_object(
      'fecha', p_fecha, 'detalle', p_detalle, 'cat', p_cat,
      'importe', p_importe, 'cuenta', p_cuenta, 'tipo', p_tipo
    ),
    'justificativo', p_justificativo,
    'cambio_saldo', v_cambio_saldo,
    'sync_gasto_id', v_orig.gasto_id_ref,
    'sync_adelanto_id', v_orig.adelanto_id_ref,
    'usuario_id', v_usuario_id,
    'editado_por_uid', v_caller_uid,
    'via_override', p_override_code IS NOT NULL
  ), v_tenant);

  v_result := jsonb_build_object(
    'ok', true,
    'mov_id', p_mov_id,
    'cambio_saldo', v_cambio_saldo
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('editar_movimiento_caja', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_aplicar_stock_venta(p_venta_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID;
  v_local_id  INTEGER;
  v_item      RECORD;
  v_rec       bigint;
  v_rend      numeric;
  v_movs      INTEGER := 0;
BEGIN
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM ventas_pos WHERE id = p_venta_id AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- AUDIT 09-jun (H6): lock por VENTA antes de abrir el cursor. El NOT EXISTS
  -- anti-redescuento se evaluaba antes del lock por insumo → dos llamadas
  -- concurrentes (doble click en cobrar) podían descontar stock dos veces.
  -- Con este lock, la 2da llamada espera y su NOT EXISTS ya ve los movimientos.
  PERFORM pg_advisory_xact_lock(hashtext('fn_aplicar_stock_venta:' || p_venta_id::text));

  FOR v_item IN
    SELECT vpi.id AS item_id, vpi.item_id AS catalog_item_id, vpi.cantidad
      FROM ventas_pos_items vpi
     WHERE vpi.venta_id = p_venta_id
       AND vpi.deleted_at IS NULL
       AND vpi.estado != 'anulado'
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos im
          WHERE im.fuente_tipo = 'venta_pos_item'
            AND im.fuente_id = vpi.id
            AND im.deleted_at IS NULL
       )
  LOOP
    PERFORM pg_advisory_xact_lock(v_item.catalog_item_id);

    SELECT r.id, GREATEST(r.rendimiento, 1)
      INTO v_rec, v_rend
      FROM recetas r
     WHERE r.item_id = v_item.catalog_item_id
       AND r.tenant_id = v_tenant_id
       AND r.activa = TRUE AND r.deleted_at IS NULL
       AND (r.local_id IS NULL OR r.local_id = v_local_id)
     ORDER BY r.local_id NULLS LAST
     LIMIT 1;

    IF v_rec IS NOT NULL THEN
      v_movs := v_movs + fn_consumir_stock_receta(
        v_rec, v_item.cantidad / v_rend, v_local_id, v_tenant_id,
        v_item.item_id, p_venta_id, 0
      );
    END IF;
  END LOOP;

  RETURN v_movs;
END;
$function$
;

-- AUDIT 09-jun (H3): ❌ FALSO POSITIVO. Se intentó reponer SECURITY DEFINER en
-- pagar_sueldo y los mutantes de sueldo fallaron (la RPC devolvía
-- completa=false bajo DEFINER). El INVOKER actual es load-bearing — se dejó
-- explícito para que ninguna reescritura futura lo "arregle" de vuelta.
ALTER FUNCTION public.pagar_sueldo(p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[], p_fecha date, p_mes integer, p_anio integer, p_crear_liq boolean, p_calc jsonb, p_idempotency_key text, p_liq_id uuid) SECURITY INVOKER;