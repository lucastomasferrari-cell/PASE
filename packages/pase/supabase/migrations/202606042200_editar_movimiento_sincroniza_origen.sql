-- 202606042200_editar_movimiento_sincroniza_origen.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- BUG (reportado por Lucas 04-jun, caso Ciro Tintilay):
-- `editar_movimiento_caja` corrige el movimiento + el saldo de caja, pero NO
-- toca el registro ORIGEN del que salió ese movimiento (gasto / adelanto).
--
-- Caso real: se cargó un "Gasto empleado / Adelanto" de $4.000.000 por error
-- (crea gasto + adelanto + movimiento, los tres en $4M). Anto editó el
-- MOVIMIENTO en Caja a $400.000 (justificativo "ERR"). El movimiento y la caja
-- quedaron en $400k, pero el gasto y el adelanto siguieron en $4M. La card de
-- Sueldos lee `rrhh_adelantos.monto` → mostraba el adelanto viejo de $4M.
--
-- Alcance verificado: 6 gastos + 1 adelanto desincronizados por este patrón
-- (cada edición de monto de un mov de gasto/adelanto dejaba el origen stale).
--
-- FIX (decisión Lucas 04-jun = auto-sincronizar):
--   1) Al editar un movimiento que viene de un GASTO o ADELANTO, sincronizar
--      monto + fecha + cuenta del registro origen.
--   2) Para movimientos que vienen de documentos complejos (factura, remito,
--      sueldo/liquidación, transferencia, pago especial) NO se permite cambiar
--      el importe desde Caja → hay que editar/anular el documento original.
--   3) Backfill: corregir los 7 registros ya desincronizados al monto real
--      (el que figura en Caja = el corregido).
--
-- Basada en la versión viva (202605202200 / override gaps). Solo se agregan
-- el check de bloqueo (paso 5a) y la cascada (paso 6b). El resto idéntico.
-- ═══════════════════════════════════════════════════════════════════════════

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
      WHERE rpc_name = 'editar_movimiento_caja' AND key = p_idempotency_key;
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
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL: corregir los registros ya desincronizados por ediciones previas.
-- El movimiento (editado=true, no anulado) tiene el monto REAL corregido; el
-- gasto/adelanto quedó con el viejo. Alineamos el origen al monto real.
-- Restringido a editado=true para tocar solo los casos de este bug.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE gastos g
   SET monto = ABS(m.importe)
  FROM movimientos m
 WHERE m.gasto_id_ref = g.id
   AND m.editado IS TRUE
   AND m.anulado IS NOT TRUE
   AND g.estado = 'activo'
   AND ABS(m.importe) <> g.monto;

UPDATE rrhh_adelantos a
   SET monto = ABS(m.importe)
  FROM movimientos m
 WHERE m.adelanto_id_ref = a.id
   AND m.editado IS TRUE
   AND m.anulado IS NOT TRUE
   AND ABS(m.importe) <> a.monto;

NOTIFY pgrst, 'reload schema';
