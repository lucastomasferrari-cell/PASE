-- ═══════════════════════════════════════════════════════════════════════════
-- MP justificativos — RPCs (commit 2/5).
--
-- 4 RPCs SECURITY DEFINER para conciliar un egreso MP con su justificativo,
-- todas atómicas dentro de la función:
--
--   fn_conciliar_mp_con_existente      — solo linkea a factura/remito/gasto ya cargado
--   fn_conciliar_mp_con_gasto          — crea gasto + movimiento + linkea
--   fn_conciliar_mp_con_egreso_manual  — crea movimiento + linkea
--   fn_conciliar_mp_con_movimiento_interno — crea 2 movimientos (out MP + in destino) + linkea
--
-- Cada RPC valida vía _validar_mp_mov_conciliable que el mp_mov:
--   1. Existe y pertenece al tenant del usuario.
--   2. Es egreso (monto < 0) y no está anulado.
--   3. NO es fee/tax (esos se auto-justifican vía backfill / import — manuales no aplican).
--   4. NO tiene ya justificativo (idempotencia: rechaza re-conciliar).
--
-- La autorización fina (por local) se delega al frontend hoy: cualquier
-- usuario con permiso al módulo MP puede conciliar (decisión Lucas). Las
-- RPCs sí validan tenant cross (defense-in-depth) — un usuario de tenant
-- A no puede tocar un mp_mov de tenant B aunque conozca el id.
--
-- Nota saldo: las RPCs que crean gasto/egreso/movimiento interno tocan
-- saldos_caja para "cuenta=MercadoPago" (y para la cuenta destino en los
-- movimientos internos), siguiendo el patrón del modal viejo. saldos_caja
-- es la vista contable interna de PASE; el saldo real MP de la UI se sigue
-- calculando aparte vía computeSaldoMP. Las dos vistas conviven y
-- eventualmente se alinean cuando todos los egresos están justificados.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Helper: valida y bloquea el row para evitar race conditions ───────────
CREATE OR REPLACE FUNCTION _validar_mp_mov_conciliable(p_mp_mov_id text)
RETURNS RECORD
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    RECORD;
  v_tenant uuid;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;

  -- FOR UPDATE evita que dos invocaciones paralelas concilien el mismo
  -- mp_mov: la segunda espera el lock y al releerlo encuentra
  -- justificativo_tipo poblado → falla con MP_MOV_YA_JUSTIFICADO.
  SELECT id, tenant_id, local_id, monto, tipo, anulado, justificativo_tipo, fecha
    INTO v_row
  FROM mp_movimientos
  WHERE id = p_mp_mov_id
  FOR UPDATE;

  IF NOT FOUND                                 THEN RAISE EXCEPTION 'MP_MOV_NO_ENCONTRADO'; END IF;
  IF v_row.tenant_id <> v_tenant               THEN RAISE EXCEPTION 'MP_MOV_CROSS_TENANT';  END IF;
  IF v_row.anulado                             THEN RAISE EXCEPTION 'MP_MOV_ANULADO';       END IF;
  IF COALESCE(v_row.monto, 0) >= 0             THEN RAISE EXCEPTION 'MP_MOV_NO_ES_EGRESO';  END IF;
  IF v_row.tipo IN ('fee', 'tax')              THEN RAISE EXCEPTION 'MP_MOV_AUTO_NO_MANUAL'; END IF;
  IF v_row.justificativo_tipo IS NOT NULL      THEN RAISE EXCEPTION 'MP_MOV_YA_JUSTIFICADO'; END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION _validar_mp_mov_conciliable(text) FROM PUBLIC;

-- ─── 1) Linkear a un registro existente (factura/remito/gasto) ─────────────
CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_existente(
  p_mp_mov_id  text,
  p_tipo       text,        -- 'factura' | 'remito' | 'gasto'
  p_justif_id  text         -- id en la tabla destino
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp           RECORD;
  v_existe       boolean;
  v_tabla_dest   text;
  v_usuario_id   integer;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  IF p_tipo NOT IN ('factura', 'remito', 'gasto') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO_PARA_EXISTENTE';
  END IF;
  IF p_justif_id IS NULL OR p_justif_id = '' THEN RAISE EXCEPTION 'JUSTIFICATIVO_ID_REQUERIDO'; END IF;

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);

  v_tabla_dest := CASE p_tipo WHEN 'factura' THEN 'facturas' WHEN 'remito' THEN 'remitos' ELSE 'gastos' END;

  -- Existe Y pertenece al mismo tenant que el mp_mov.
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = $1 AND tenant_id = $2)', v_tabla_dest)
    INTO v_existe
    USING p_justif_id, v_mp.tenant_id;
  IF NOT v_existe THEN RAISE EXCEPTION 'JUSTIFICATIVO_NO_ENCONTRADO'; END IF;

  UPDATE mp_movimientos
     SET justificativo_tipo = p_tipo,
         justificativo_id   = p_justif_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_EXISTENTE', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'tipo', p_tipo, 'justif_id', p_justif_id,
    'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', p_tipo, 'justificativo_id', p_justif_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_existente(text, text, text) TO authenticated;

-- ─── 2) Crear gasto nuevo + linkear ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_gasto(
  p_mp_mov_id  text,
  p_gasto_data jsonb       -- { categoria, detalle?, tipo? }   (todo opcional excepto categoria)
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
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

  PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_monto_abs);

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
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_gasto(text, jsonb) TO authenticated;

-- ─── 3) Crear egreso manual nuevo (movimiento sin gasto) + linkear ─────────
CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_egreso_manual(
  p_mp_mov_id   text,
  p_egreso_data jsonb       -- { detalle?, cat? }
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp          RECORD;
  v_usuario_id  integer;
  v_mov_id      text;
  v_monto_abs   numeric;
  v_detalle     text;
  v_cat         text;
  v_fecha       date;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  v_detalle := COALESCE(p_egreso_data->>'detalle', '');
  v_cat     := COALESCE(nullif(trim(p_egreso_data->>'cat'), ''), 'EGRESO_MANUAL');

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);
  v_monto_abs := abs(v_mp.monto);
  v_fecha := COALESCE((v_mp.fecha)::date, current_date);

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id, fact_id)
    VALUES (v_mov_id, v_fecha, 'MercadoPago', 'Conciliación MP - Egreso manual', v_cat,
            -v_monto_abs, COALESCE(nullif(v_detalle, ''), 'Conciliación MP'),
            v_mp.local_id, v_mp.tenant_id, NULL);

  PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_monto_abs);

  UPDATE mp_movimientos
     SET justificativo_tipo = 'egreso_manual',
         justificativo_id   = v_mov_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_EGRESO_MANUAL', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'mov_id', v_mov_id, 'monto', v_monto_abs,
    'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object('mp_mov_id', p_mp_mov_id, 'tipo', 'egreso_manual', 'mov_id', v_mov_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_egreso_manual(text, jsonb) TO authenticated;

-- ─── 4) Movimiento interno (transferencia a cuenta propia) + linkear ───────
CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_movimiento_interno(
  p_mp_mov_id      text,
  p_destino_cuenta text,         -- ej: 'Banco Galicia'
  p_detalle        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Salida desde MercadoPago
  v_mov_out_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id)
    VALUES (v_mov_out_id, v_fecha, 'MercadoPago', 'Transferencia entre cuentas',
            'MOVIMIENTO_INTERNO', -v_monto_abs, v_detalle, v_mp.local_id, v_mp.tenant_id);
  PERFORM _actualizar_saldo_caja('MercadoPago', v_mp.local_id, -v_monto_abs);

  -- Entrada en cuenta destino. Misma fecha, mismo monto absoluto, contraparte.
  v_mov_in_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id)
    VALUES (v_mov_in_id, v_fecha, p_destino_cuenta, 'Transferencia entre cuentas',
            'MOVIMIENTO_INTERNO', v_monto_abs, v_detalle, v_mp.local_id, v_mp.tenant_id);
  PERFORM _actualizar_saldo_caja(p_destino_cuenta, v_mp.local_id, v_monto_abs);

  UPDATE mp_movimientos
     SET justificativo_tipo = 'movimiento_interno',
         justificativo_id   = v_mov_out_id,   -- el de origen es el "ancla"
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
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_movimiento_interno(text, text, text) TO authenticated;
