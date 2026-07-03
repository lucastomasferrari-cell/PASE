-- =====================================================================
-- 202607030900_comanda_fixes_plata.sql
-- Fixes de PLATA en el POS COMANDA (auditoría 03-jul).
--
-- Corrige 6 bugs de dinero confirmados, con cambios QUIRÚRGICOS sobre los
-- cuerpos actuales de las funciones (mismo cuerpo verbatim + diff mínimo):
--
--   1. fn_agregar_pago_venta_comanda
--        - PLATA FANTASMA: cobro parcial sin turno dejaba la venta cobrada
--          SIN movimiento de caja. Ahora resuelve/exige turno y SIEMPRE
--          inserta el movimiento.
--        - PAGO NEGATIVO/CERO: p_monto <= 0 se rechaza (MONTO_INVALIDO).
--   2. fn_refund_venta_comanda
--        - REFUND NO REVERTÍA CAJA: marcaba pagos 'reembolsado' pero no
--          insertaba movimiento compensatorio. Ahora reversa la caja
--          (mismo patrón que fn_reabrir_venta_comanda).
--   3. fn_trg_puente_caja_comanda
--        - INVERSIÓN DE SIGNO EN ANULACIÓN: el reverso ya viene con monto
--          negativo; -NEW.monto lo invertía (sumaba a caja PASE).
--   4. fn_movimiento_caja_comanda
--        - AJUSTE/DEPÓSITO SIN TOPE + BYPASS DE $5000: el gate de manager
--          sólo aplicaba a 'retiro' y con '>' (dejaba pasar el umbral exacto).
--          Ahora aplica a TODO tipo y con '>='.
--   5. fn_cobrar_venta_comanda (hardening)
--        - LOCK de la venta (FOR UPDATE), chequeo de local autorizado,
--          rechazo de pagos <= 0, e idempotencia en el ledger de caja.
--
-- Idempotente / re-ejecutable (todo CREATE OR REPLACE, sin DDL destructiva).
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1. fn_agregar_pago_venta_comanda — PLATA FANTASMA + PAGO NEGATIVO
-- =====================================================================
CREATE OR REPLACE FUNCTION public.fn_agregar_pago_venta_comanda(p_venta_id bigint, p_metodo text, p_monto numeric, p_idempotency_key text, p_cobrado_por uuid DEFAULT NULL::uuid, p_vuelto numeric DEFAULT NULL::numeric, p_propina_incluida numeric DEFAULT 0, p_cuotas integer DEFAULT NULL::integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_pago_id BIGINT;
  v_total_pagado NUMERIC;
  v_local_id INTEGER;
  v_turno_id BIGINT;
  v_cuotas_efectivo INTEGER;
BEGIN
  SELECT id INTO v_pago_id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key;
  IF v_pago_id IS NOT NULL THEN RETURN v_pago_id; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- AUDIT F2B #5: defense-in-depth contra cross-tenant.
  -- Sin esto, cualquier authenticated podía pagar ventas de otro tenant
  -- iterando p_venta_id (BIGSERIAL global enumerable).
  PERFORM fn_assert_local_autorizado(v_venta.local_id);

  IF v_venta.estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_venta.estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_total_pagado
    FROM ventas_pos_pagos
   WHERE venta_id = p_venta_id AND estado = 'confirmado';

  IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN
    RAISE EXCEPTION 'SOBREPAGO: cobrarías % cuando faltan %',
      p_monto, GREATEST(0, v_venta.total - v_total_pagado);
  END IF;

  v_cuotas_efectivo := CASE
    WHEN p_cuotas IS NULL THEN NULL
    WHEN lower(p_metodo) LIKE '%credit%' THEN p_cuotas
    WHEN lower(p_metodo) LIKE '%tc%' THEN p_cuotas
    ELSE NULL
  END;

  INSERT INTO ventas_pos_pagos (
    tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
    cobrado_por, vuelto, propina_incluida, cuotas, estado, confirmado_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, p_metodo, p_monto, p_idempotency_key,
    COALESCE(p_cobrado_por, v_venta.cajero_id), p_vuelto, COALESCE(p_propina_incluida, 0),
    v_cuotas_efectivo,
    'confirmado', NOW()
  ) RETURNING id INTO v_pago_id;

  IF v_total_pagado + p_monto >= v_venta.total - 0.01 THEN
    UPDATE ventas_pos SET
      estado = 'cobrada',
      cobrada_at = NOW(),
      updated_at = NOW()
    WHERE id = p_venta_id;

    IF v_venta.mesa_id IS NOT NULL THEN
      UPDATE mesas SET estado = 'libre' WHERE id = v_venta.mesa_id;
    END IF;
  END IF;

  v_local_id := v_venta.local_id;
  v_turno_id := v_venta.turno_caja_id;
  -- FIX (audit 03-jul): sin turno la plata quedaba cobrada SIN movimiento de
  -- caja (plata fantasma). Resolver el turno abierto o abortar, como el cobro
  -- de una sola vez.
  IF v_turno_id IS NULL THEN
    SELECT id INTO v_turno_id FROM turnos_caja
     WHERE local_id = v_local_id AND estado = 'abierto' LIMIT 1;
    IF v_turno_id IS NULL THEN RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO'; END IF;
    UPDATE ventas_pos SET turno_caja_id = v_turno_id WHERE id = p_venta_id;
  END IF;
  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo,
    monto, metodo, motivo, venta_id, idempotency_key
  ) VALUES (
    v_venta.tenant_id, v_local_id, v_turno_id,
    COALESCE(p_cobrado_por, (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
    'venta', p_monto, p_metodo,
    'Cobro venta #' || p_venta_id, p_venta_id,
    'mov_' || p_idempotency_key
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN v_pago_id;
END;
$function$;


-- =====================================================================
-- 2. fn_refund_venta_comanda — REFUND NO REVERTÍA CAJA
-- =====================================================================
CREATE OR REPLACE FUNCTION public.fn_refund_venta_comanda(p_venta_id bigint, p_manager_id uuid, p_motivo text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_cajero UUID;
  v_existing BIGINT;
  v_turno_id BIGINT;
  v_pago RECORD;
  v_empleado UUID;
  v_tenant UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      SELECT total INTO v_total FROM ventas_pos WHERE id = p_venta_id;
      RETURN COALESCE(v_total, 0);
    END IF;
  END IF;

  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  SELECT local_id, total, cajero_id, tenant_id INTO v_local_id, v_total, v_cajero, v_tenant
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);

  -- FIX (audit 03-jul): el refund marcaba los pagos 'reembolsado' pero NO
  -- insertaba movimiento compensatorio → la caja seguía mostrando el ingreso.
  -- Reverso de caja (mismo patrón que fn_reabrir_venta_comanda).
  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = v_local_id AND estado = 'abierto' LIMIT 1;
  v_empleado := v_cajero;
  IF v_empleado IS NULL AND v_turno_id IS NOT NULL THEN
    SELECT cajero_id INTO v_empleado FROM turnos_caja WHERE id = v_turno_id;
  END IF;
  FOR v_pago IN
    SELECT id, metodo, monto, cobrado_por FROM ventas_pos_pagos
     WHERE venta_id = p_venta_id AND estado = 'confirmado' AND deleted_at IS NULL
  LOOP
    IF v_turno_id IS NOT NULL THEN
      INSERT INTO movimientos_caja (
        tenant_id, local_id, turno_caja_id, empleado_id,
        tipo, monto, metodo, motivo, venta_id, idempotency_key
      ) VALUES (
        v_tenant, v_local_id, v_turno_id, COALESCE(v_pago.cobrado_por, v_empleado),
        'venta_anulada', -ABS(v_pago.monto), v_pago.metodo,
        'Reverso por refund de venta #' || p_venta_id, p_venta_id,
        'reverso_refund_' || p_venta_id || '_' || v_pago.id
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    ELSE
      INSERT INTO reversos_pendientes (
        tenant_id, local_id, venta_id, pago_id, empleado_id,
        metodo, monto, motivo, idempotency_key
      ) VALUES (
        v_tenant, v_local_id, p_venta_id, v_pago.id,
        COALESCE(v_pago.cobrado_por, v_empleado),
        v_pago.metodo, v_pago.monto,
        'Reverso pendiente por refund de venta #' || p_venta_id,
        'reverso_refund_' || p_venta_id || '_' || v_pago.id
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END LOOP;

  UPDATE ventas_pos_pagos SET
    estado = 'reembolsado', reembolsado_at = NOW(), updated_at = NOW()
  WHERE venta_id = p_venta_id AND estado = 'confirmado';

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
    p_manager_id, 'refund', p_motivo, v_total, p_idempotency_key
  );
  RETURN v_total;
END;
$function$;


-- =====================================================================
-- 3. fn_trg_puente_caja_comanda — INVERSIÓN DE SIGNO EN ANULACIÓN
-- =====================================================================
CREATE OR REPLACE FUNCTION public.fn_trg_puente_caja_comanda()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_flag BOOLEAN;
  v_cuenta TEXT;
  v_mov_id TEXT;
  v_tenant_id UUID;
  v_fecha DATE;
  v_tipo_pase TEXT;
  v_cat TEXT;
  v_importe NUMERIC;
  v_detalle TEXT;
  v_rows INTEGER;
BEGIN
  -- Gate: solo bridgear si el local usa COMANDA como fuente
  SELECT comanda_fuente_de_verdad INTO v_flag
    FROM locales WHERE id = NEW.local_id;
  IF NOT COALESCE(v_flag, FALSE) THEN
    RETURN NEW;
  END IF;

  -- Apertura y cierre son operativos, no financieros
  IF NEW.tipo IN ('apertura', 'cierre') THEN
    RETURN NEW;
  END IF;

  -- Resolver cuenta_destino desde medios_cobro
  -- El POS guarda slug en metodo; buscamos slug o nombre
  SELECT mc.cuenta_destino INTO v_cuenta
    FROM medios_cobro mc
   WHERE mc.tenant_id = NEW.tenant_id
     AND (mc.local_id IS NULL OR mc.local_id = NEW.local_id)
     AND mc.deleted_at IS NULL
     AND (mc.slug = NEW.metodo OR upper(mc.nombre) = upper(NEW.metodo))
   ORDER BY mc.local_id NULLS LAST
   LIMIT 1;

  -- Sin cuenta_destino = sin impacto en caja (tarjetas, online, etc.)
  IF v_cuenta IS NULL OR v_cuenta = '' THEN
    RETURN NEW;
  END IF;

  v_fecha := (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_tenant_id := NEW.tenant_id;

  -- Mapear tipo COMANDA → tipo/cat/importe PASE
  CASE NEW.tipo
    WHEN 'venta' THEN
      v_tipo_pase := 'Ingreso Venta';
      v_cat := 'VENTAS';
      v_importe := NEW.monto;
      v_detalle := 'COMANDA venta #' || COALESCE(NEW.venta_id::TEXT, '');
    WHEN 'venta_anulada' THEN
      v_tipo_pase := 'Ingreso Venta';
      v_cat := 'VENTAS';
      v_importe := NEW.monto;  -- FIX (03-jul): el reverso ya viene con monto NEGATIVO; -NEW.monto lo invertía (sumaba a caja PASE en vez de restar)
      v_detalle := 'COMANDA anulación venta #' || COALESCE(NEW.venta_id::TEXT, '');
    WHEN 'retiro' THEN
      v_tipo_pase := 'Egreso';
      v_cat := 'CAJA';
      v_importe := -NEW.monto;
      v_detalle := 'COMANDA retiro: ' || COALESCE(NEW.motivo, '');
    WHEN 'deposito' THEN
      v_tipo_pase := 'Ingreso';
      v_cat := 'CAJA';
      v_importe := NEW.monto;
      v_detalle := 'COMANDA depósito: ' || COALESCE(NEW.motivo, '');
    WHEN 'ajuste' THEN
      v_tipo_pase := CASE WHEN NEW.monto >= 0 THEN 'Ingreso' ELSE 'Egreso' END;
      v_cat := 'CAJA';
      v_importe := NEW.monto;
      v_detalle := 'COMANDA ajuste: ' || COALESCE(NEW.motivo, '');
    ELSE
      RETURN NEW;
  END CASE;

  -- Insertar movimiento PASE (idempotente por comanda_ref)
  v_mov_id := _gen_id_compat('MOV');
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle,
    local_id, tenant_id, comanda_ref
  ) VALUES (
    v_mov_id, v_fecha, v_cuenta, v_tipo_pase, v_cat,
    v_importe, v_detalle, NEW.local_id, v_tenant_id,
    'cmov_' || NEW.id::TEXT
  )
  ON CONFLICT (comanda_ref) WHERE comanda_ref IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    PERFORM _actualizar_saldo_caja(v_cuenta, NEW.local_id, v_importe);
  END IF;

  RETURN NEW;
END;
$function$;


-- =====================================================================
-- 4. fn_movimiento_caja_comanda — AJUSTE/DEPÓSITO SIN TOPE + BYPASS $5000
-- =====================================================================
CREATE OR REPLACE FUNCTION public.fn_movimiento_caja_comanda(p_local_id integer, p_empleado_id uuid, p_tipo text, p_monto numeric, p_metodo text, p_motivo text, p_idempotency_key text DEFAULT NULL::text, p_manager_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_turno_id BIGINT;
  v_mov_id BIGINT;
  v_existing_id BIGINT;
  v_umbral_override CONSTANT NUMERIC := 5000;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM movimientos_caja
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;
  END IF;

  PERFORM fn_assert_local_autorizado(p_local_id);
  PERFORM fn_assert_empleado_en_local(p_empleado_id, p_local_id);

  IF NOT fn_check_perm_comanda('comanda.caja.movimientos') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_MOVIMIENTOS';
  END IF;
  IF p_tipo NOT IN ('retiro','deposito','ajuste') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;

  -- FIX (audit 03-jul): el gate de manager sólo cubría 'retiro' y usaba '>'
  -- (dejaba pasar depósitos/ajustes sin tope y el umbral exacto de $5000).
  -- Ahora aplica a TODO movimiento y con '>='.
  IF ABS(p_monto) >= v_umbral_override THEN
    IF p_manager_id IS NULL THEN
      RAISE EXCEPTION 'RETIRO_REQUIERE_MANAGER: movimientos de caja >= $% requieren autorización de manager', v_umbral_override;
    END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, p_local_id);
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
      WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND activo = TRUE
    ) THEN
      RAISE EXCEPTION 'MANAGER_INVALIDO: el empleado % no es manager ni dueño', p_manager_id;
    END IF;
    IF p_motivo IS NULL OR LENGTH(TRIM(p_motivo)) < 10 THEN
      RAISE EXCEPTION 'MOTIVO_REQUERIDO: motivo debe tener al menos 10 caracteres para movimientos de caja >= $%', v_umbral_override;
    END IF;
  END IF;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;
  IF v_turno_id IS NULL THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_empleado_id, p_tipo, p_monto, p_metodo, p_motivo,
    p_idempotency_key
  ) RETURNING id INTO v_mov_id;

  IF ABS(p_monto) >= v_umbral_override AND p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id,
      accion, motivo, monto_afectado, idempotency_key
    ) VALUES (
      auth_tenant_id(), p_local_id, NULL, p_empleado_id, p_manager_id,
      'retiro_caja', p_motivo, ABS(p_monto),
      CASE WHEN p_idempotency_key IS NOT NULL
           THEN 'override_' || p_idempotency_key
           ELSE NULL END
    );
  END IF;

  RETURN v_mov_id;
END;
$function$;


-- =====================================================================
-- 5. fn_cobrar_venta_comanda — hardening: LOCK + LOCAL + NEGATIVO + LEDGER IDEMPOTENCY
-- =====================================================================
CREATE OR REPLACE FUNCTION public.fn_cobrar_venta_comanda(p_venta_id bigint, p_pagos jsonb, p_propina numeric DEFAULT 0, p_cobrado_por uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
  v_total NUMERIC;
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_suma_pagos NUMERIC := 0;
  v_pago JSONB;
  v_turno_id BIGINT;
  v_mesa_id BIGINT;
  v_existing_key TEXT;
  v_item RECORD;
  v_version_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  -- IDEMPOTENCY a nivel header.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT cobro_idempotency_key, total INTO v_existing_key, v_total
    FROM ventas_pos WHERE id = p_venta_id;
    IF v_existing_key = p_idempotency_key THEN
      RETURN COALESCE(v_total, 0);
    END IF;
  END IF;

  SELECT local_id, estado, subtotal, descuento_total, turno_caja_id, mesa_id
    INTO v_local_id, v_estado, v_subtotal, v_descuento, v_turno_id, v_mesa_id
    FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);
  IF v_estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  -- FIX 2026-05-15: si la venta no tiene turno asignado, buscar el turno
  -- abierto del local. Si tampoco hay, abortar — plata no puede quedar
  -- flotando sin arqueo.
  IF v_turno_id IS NULL THEN
    SELECT id INTO v_turno_id FROM turnos_caja
     WHERE local_id = v_local_id AND estado = 'abierto' LIMIT 1;
    IF v_turno_id IS NULL THEN
      RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
    END IF;
    -- Asignar el turno a la venta para que quede consistente.
    UPDATE ventas_pos SET turno_caja_id = v_turno_id WHERE id = p_venta_id;
  END IF;

  v_total := v_subtotal - v_descuento + COALESCE(p_propina, 0);
  v_total := GREATEST(0, v_total);

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    IF COALESCE((v_pago->>'monto')::NUMERIC, 0) <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
    v_suma_pagos := v_suma_pagos + COALESCE((v_pago->>'monto')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_suma_pagos - v_total) > 0.01 THEN
    RAISE EXCEPTION 'SUMA_PAGOS_NO_COINCIDE: suma=% total=%', v_suma_pagos, v_total;
  END IF;

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO ventas_pos_pagos (
      tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
      vuelto, propina_incluida, cobrado_por, estado, confirmado_at
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id,
      v_pago->>'metodo',
      (v_pago->>'monto')::NUMERIC,
      v_pago->>'idempotency_key',
      NULLIF((v_pago->>'vuelto'),'')::NUMERIC,
      COALESCE((v_pago->>'propina_incluida')::NUMERIC, 0),
      p_cobrado_por,
      'confirmado',
      NOW()
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  -- F1.1c: snapshot de receta por item (best-effort).
  FOR v_item IN
    SELECT id, item_id FROM ventas_pos_items
    WHERE venta_id = p_venta_id
      AND deleted_at IS NULL
      AND estado <> 'anulado'
      AND receta_version_id IS NULL
  LOOP
    BEGIN
      v_version_id := fn_snapshot_receta_a_version(v_item.item_id);
      IF v_version_id IS NOT NULL THEN
        UPDATE ventas_pos_items SET receta_version_id = v_version_id WHERE id = v_item.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'F1.1c snapshot falló item_id=%, venta_id=%: %', v_item.item_id, p_venta_id, SQLERRM;
    END;
  END LOOP;

  UPDATE ventas_pos SET
    estado = 'cobrada', propina = COALESCE(p_propina, 0),
    cobrada_at = NOW(),
    total = v_total,
    cobro_idempotency_key = COALESCE(p_idempotency_key, cobro_idempotency_key),
    updated_at = NOW()
  WHERE id = p_venta_id;

  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Insertar movimientos_caja — ahora v_turno_id NUNCA es NULL.
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id, tipo,
      monto, metodo, motivo, venta_id, idempotency_key
    ) VALUES (
      auth_tenant_id(), v_local_id, v_turno_id, COALESCE(p_cobrado_por,
        (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
      'venta', (v_pago->>'monto')::NUMERIC, v_pago->>'metodo',
      'Cobro venta #' || p_venta_id, p_venta_id,
      'mov_' || COALESCE(v_pago->>'idempotency_key', p_idempotency_key || '_' || (v_pago->>'metodo'))
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  RETURN v_total;
END;
$function$;

COMMIT;
