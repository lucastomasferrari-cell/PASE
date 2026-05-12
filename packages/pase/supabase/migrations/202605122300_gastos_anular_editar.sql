-- ═══════════════════════════════════════════════════════════════════════════
-- Gastos: agregar columnas de auditoría (anulado/editado) + RPCs atómicas
-- anular_gasto, editar_gasto + actualizar anular_movimiento para que cuando
-- anulen el mov desde Tesorería también marquen el gasto.
--
-- Bug reportado por Lucas 2026-05-12: "los movimientos dentro de gastos no
-- se pueden editar ni borrar y deberían estar atados a los movimientos de
-- tesorería". Hoy crear_gasto inserta gasto + mov vinculado vía
-- movimientos.gasto_id_ref, pero NO había forma de revertir/editar desde la
-- UI de Gastos, y al anular el mov en Tesorería el gasto quedaba huérfano.
--
-- Esta migration:
-- 1. Agrega columnas anulado_*/editado_* a gastos (mismo patrón que
--    movimientos).
-- 2. CHECK constraint gastos.estado IN ('activo','anulado').
-- 3. RPC anular_gasto: marca gasto anulado + anula mov asociado + revierte
--    saldos_caja, todo en TX. Permiso compras_anular (gastos son operación
--    administrativa similar a anular factura).
-- 4. RPC editar_gasto: edita gasto + mov + ajusta saldos si cambió cuenta
--    o monto, en TX. Idempotency key.
-- 5. anular_movimiento: cuando el mov a anular tiene gasto_id_ref, también
--    marcar el gasto como anulado. Bidireccional con anular_gasto.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1) Columnas de auditoría en gastos ────────────────────────────────────
ALTER TABLE gastos
  ADD COLUMN IF NOT EXISTS anulado_motivo TEXT,
  ADD COLUMN IF NOT EXISTS anulado_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anulado_por    INTEGER REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS editado        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS editado_motivo TEXT,
  ADD COLUMN IF NOT EXISTS editado_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS editado_por    INTEGER REFERENCES usuarios(id);

-- ─── 2) CHECK constraint en estado ─────────────────────────────────────────
-- Drop si existe (idempotente — facilita re-correr la migration).
ALTER TABLE gastos DROP CONSTRAINT IF EXISTS gastos_estado_check;
ALTER TABLE gastos
  ADD CONSTRAINT gastos_estado_check
  CHECK (estado IS NULL OR estado IN ('activo', 'anulado'));

-- ─── 3) RPC anular_gasto ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION anular_gasto(
  p_gasto_id text,
  p_motivo   text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_gasto RECORD;
  v_mov RECORD;
BEGIN
  -- Permiso granular (regla C11). Reusamos compras_anular porque gastos
  -- son operaciones administrativas del mismo grupo. Si Lucas quiere un
  -- permiso aparte (gastos_anular), se agrega después.
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras_anular')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_motivo IS NULL OR trim(p_motivo) = '' THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  -- Lock + validaciones del gasto
  SELECT * INTO v_gasto FROM gastos WHERE id = p_gasto_id FOR UPDATE;
  IF v_gasto IS NULL THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;
  IF v_gasto.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;
  IF v_gasto.estado = 'anulado' THEN RAISE EXCEPTION 'GASTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_gasto.local_id);

  -- Buscar movimiento asociado (vía gasto_id_ref). Puede no existir si el
  -- gasto fue cargado pre-2026-04 (antes del vínculo gasto_id_ref) o si
  -- ya se anuló por separado.
  SELECT * INTO v_mov FROM movimientos
    WHERE gasto_id_ref = p_gasto_id AND COALESCE(anulado, false) = false
    FOR UPDATE
    LIMIT 1;

  -- Revertir saldo de la cuenta si hay mov activo
  IF v_mov.id IS NOT NULL AND v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
    UPDATE movimientos
       SET anulado = true,
           anulado_motivo = 'Anulado por anular gasto ' || p_gasto_id || ' — motivo: ' || p_motivo
     WHERE id = v_mov.id;
  END IF;

  -- Marcar gasto anulado
  UPDATE gastos
     SET estado = 'anulado',
         anulado_motivo = p_motivo,
         anulado_at = now(),
         anulado_por = v_usuario_id
   WHERE id = p_gasto_id;

  PERFORM _auditar('gastos', 'ANULACION', jsonb_build_object(
    'gasto_id', p_gasto_id, 'motivo', p_motivo,
    'mov_id_anulado', v_mov.id,
    'monto_revertido', v_mov.importe,
    'usuario_id', v_usuario_id,
    'anulado_por_uid', v_caller_uid
  ), v_tenant);

  RETURN jsonb_build_object(
    'gasto_id', p_gasto_id,
    'mov_id', v_mov.id,
    'anulado', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION anular_gasto(text, text) TO authenticated;
REVOKE ALL ON FUNCTION anular_gasto(text, text) FROM PUBLIC;

-- ─── 4) RPC editar_gasto ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION editar_gasto(
  p_gasto_id        text,
  p_fecha           date,
  p_categoria       text,
  p_tipo            text,
  p_monto           numeric,
  p_cuenta          text,
  p_detalle         text,
  p_justificativo   text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_gasto RECORD;
  v_mov RECORD;
  v_cached jsonb;
  v_result jsonb;
  v_cambio_saldo boolean;
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras_anular')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR trim(p_cuenta) = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR trim(p_categoria) = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;
  IF p_justificativo IS NULL OR trim(p_justificativo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'editar_gasto' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_gasto FROM gastos WHERE id = p_gasto_id FOR UPDATE;
  IF v_gasto IS NULL THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;
  IF v_gasto.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;
  IF v_gasto.estado = 'anulado' THEN RAISE EXCEPTION 'GASTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_gasto.local_id);

  -- Mov asociado (puede no existir si gasto legacy pre-vínculo)
  SELECT * INTO v_mov FROM movimientos
    WHERE gasto_id_ref = p_gasto_id AND COALESCE(anulado, false) = false
    FOR UPDATE
    LIMIT 1;

  v_cambio_saldo := (v_gasto.cuenta IS DISTINCT FROM p_cuenta)
                 OR (v_gasto.monto IS DISTINCT FROM p_monto);

  -- Si hay mov asociado y cambió cuenta/monto, ajustar saldos
  IF v_mov.id IS NOT NULL AND v_cambio_saldo AND v_gasto.local_id IS NOT NULL THEN
    -- Revertir el impacto del mov viejo
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_gasto.local_id, -COALESCE(v_mov.importe, 0));
    -- Aplicar el impacto nuevo (importe = -p_monto porque es egreso)
    PERFORM _actualizar_saldo_caja(p_cuenta, v_gasto.local_id, -p_monto);
  END IF;

  -- Update gasto
  UPDATE gastos
     SET fecha = p_fecha,
         categoria = p_categoria,
         tipo = p_tipo,
         monto = p_monto,
         cuenta = p_cuenta,
         detalle = p_detalle,
         editado = true,
         editado_motivo = p_justificativo,
         editado_at = now(),
         editado_por = v_usuario_id
   WHERE id = p_gasto_id;

  -- Update mov (si existe) — mantiene el vínculo bidireccional
  IF v_mov.id IS NOT NULL THEN
    UPDATE movimientos
       SET fecha = p_fecha,
           cuenta = p_cuenta,
           importe = -p_monto,
           cat = p_categoria,
           detalle = COALESCE(p_detalle, p_categoria),
           tipo = 'Gasto ' || COALESCE(p_tipo, ''),
           editado = true,
           editado_motivo = p_justificativo,
           editado_at = now()
     WHERE id = v_mov.id;
  END IF;

  PERFORM _auditar('gastos', 'EDICION', jsonb_build_object(
    'gasto_id', p_gasto_id,
    'antes', to_jsonb(v_gasto),
    'despues', jsonb_build_object(
      'fecha', p_fecha, 'categoria', p_categoria, 'tipo', p_tipo,
      'monto', p_monto, 'cuenta', p_cuenta, 'detalle', p_detalle
    ),
    'justificativo', p_justificativo,
    'mov_id', v_mov.id,
    'usuario_id', v_usuario_id,
    'editado_por_uid', v_caller_uid
  ), v_tenant);

  v_result := jsonb_build_object(
    'ok', true,
    'gasto_id', p_gasto_id,
    'mov_id', v_mov.id,
    'cambio_saldo', v_cambio_saldo
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('editar_gasto', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION editar_gasto(text, date, text, text, numeric, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION editar_gasto(text, date, text, text, numeric, text, text, text, text) FROM PUBLIC;

-- ─── 5) anular_movimiento: reflejar en gasto si tiene gasto_id_ref ─────────
-- Re-creamos la RPC entera (no podemos hacer un patch parcial). El cuerpo
-- es el mismo que 202605121800 + un IF al final para marcar el gasto.
CREATE OR REPLACE FUNCTION anular_movimiento(p_mov_id text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov RECORD; v_pareja RECORD; v_gasto_id text;
  v_anulados text[] := ARRAY[]::text[]; v_tenant uuid;
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('caja_anular')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso caja_anular';
  END IF;

  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;

  PERFORM _validar_local_autorizado(v_mov.local_id);
  v_tenant := v_mov.tenant_id;

  IF v_mov.transferencia_id IS NOT NULL THEN
    FOR v_pareja IN SELECT * FROM movimientos
     WHERE transferencia_id = v_mov.transferencia_id AND anulado IS DISTINCT FROM TRUE
     ORDER BY id LOOP
      PERFORM _validar_local_autorizado(v_pareja.local_id);
      UPDATE movimientos SET anulado = true, anulado_motivo = p_motivo WHERE id = v_pareja.id;
      IF v_pareja.local_id IS NOT NULL THEN
        PERFORM _actualizar_saldo_caja(v_pareja.cuenta, v_pareja.local_id, -COALESCE(v_pareja.importe, 0));
      END IF;
      v_anulados := array_append(v_anulados, v_pareja.id);
    END LOOP;

    PERFORM _auditar('movimientos', 'ANULACION_TRANSFERENCIA', jsonb_build_object(
      'mov_id_solicitado', p_mov_id, 'transferencia_id', v_mov.transferencia_id,
      'movs_anulados', to_jsonb(v_anulados), 'motivo', p_motivo,
      'usuario_id', auth_usuario_id()
    ), v_tenant);

    RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true,
      'transferencia_id', v_mov.transferencia_id, 'movs_anulados', to_jsonb(v_anulados));
  END IF;

  UPDATE movimientos SET anulado = true, anulado_motivo = p_motivo WHERE id = p_mov_id;
  IF v_mov.local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(v_mov.cuenta, v_mov.local_id, -COALESCE(v_mov.importe, 0));
  END IF;

  IF v_mov.liquidacion_id IS NOT NULL THEN
    UPDATE rrhh_liquidaciones SET anulado = true WHERE id = v_mov.liquidacion_id;
  ELSIF v_mov.cat = 'SUELDOS' AND v_mov.local_id IS NOT NULL THEN
    SELECT id INTO v_gasto_id FROM gastos
     WHERE detalle = v_mov.detalle AND fecha = v_mov.fecha
       AND cuenta = v_mov.cuenta AND local_id = v_mov.local_id
     LIMIT 1;
    IF v_gasto_id IS NOT NULL THEN
      UPDATE rrhh_liquidaciones SET anulado = true WHERE gasto_id = v_gasto_id;
    END IF;
  END IF;

  -- NUEVO 2026-05-12: si el mov tiene gasto_id_ref, marcar el gasto anulado.
  -- Esto cierra el vínculo bidireccional con anular_gasto (que también marca
  -- el mov al anular el gasto).
  IF v_mov.gasto_id_ref IS NOT NULL THEN
    UPDATE gastos
       SET estado = 'anulado',
           anulado_motivo = COALESCE(anulado_motivo, 'Anulado al anular movimiento ' || p_mov_id || ' — motivo: ' || p_motivo),
           anulado_at = COALESCE(anulado_at, now()),
           anulado_por = COALESCE(anulado_por, auth_usuario_id())
     WHERE id = v_mov.gasto_id_ref AND estado <> 'anulado';
  END IF;

  PERFORM _auditar('movimientos', 'ANULACION', jsonb_build_object(
    'mov_id', p_mov_id, 'motivo', p_motivo,
    'movimiento', to_jsonb(v_mov), 'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('mov_id', p_mov_id, 'anulado', true);
END;
$$;
