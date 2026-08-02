-- Guard "justificativo ya usado" al conciliar MP con doc EXISTENTE (auditoría 01-ago)
-- ---------------------------------------------------------------------------
-- Hallazgo mpJustif: fn_conciliar_mp_con_existente y fn_conciliar_mp_con_gasto_existente
-- vinculan un gasto/factura/remito YA existente a un mp_movimiento SIN chequear que ese
-- justificativo no esté ya vinculado a OTRO mp_movimiento. El único freno era el dropdown
-- del front (excluye ya-usados) que se corta a 5000 filas sin filtro de fecha → a escala se
-- podía reusar el mismo justificativo en dos egresos MP (doble descargo del mismo gasto).
--
-- Las funciones que CREAN el doc (fn_conciliar_mp_con_gasto / _factura_nueva / _remito_nuevo)
-- no necesitan guard: generan un id nuevo cada vez, no hay reuso posible.
--
-- Fix: antes del UPDATE, rechazar si (justificativo_tipo, justificativo_id) ya está tomado
-- por otro mp_movimiento. RAISE 'JUSTIFICATIVO_YA_USADO' (traducido en errors.ts).

-- 1) fn_conciliar_mp_con_existente (factura / remito / gasto)
CREATE OR REPLACE FUNCTION public.fn_conciliar_mp_con_existente(p_mp_mov_id text, p_tipo text, p_justif_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp           RECORD;
  v_existe       boolean;
  v_tabla_dest   text;
  v_usuario_id   integer;
  v_ya_usado_por text;
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

  -- Guard reuso: el justificativo no puede estar ya vinculado a otro mp_movimiento.
  SELECT id INTO v_ya_usado_por
    FROM mp_movimientos
   WHERE justificativo_tipo = p_tipo
     AND justificativo_id   = p_justif_id
     AND id <> p_mp_mov_id
   LIMIT 1;
  IF v_ya_usado_por IS NOT NULL THEN
    RAISE EXCEPTION 'JUSTIFICATIVO_YA_USADO';
  END IF;

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
$function$;

-- 2) fn_conciliar_mp_con_gasto_existente
CREATE OR REPLACE FUNCTION public.fn_conciliar_mp_con_gasto_existente(p_mp_mov_id text, p_gasto_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mp            RECORD;
  v_usuario_id    integer;
  v_gasto_monto   numeric;
  v_mp_monto_abs  numeric;
  v_diff          numeric;
  v_warning       text := NULL;
  v_ya_usado_por  text;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  IF p_gasto_id IS NULL OR p_gasto_id = '' THEN
    RAISE EXCEPTION 'GASTO_ID_REQUERIDO';
  END IF;

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);

  -- Existe + mismo tenant + no soft-deleted (gastos no tiene deleted_at;
  -- si en algún momento se agrega, ajustar acá).
  SELECT monto INTO v_gasto_monto
    FROM gastos
   WHERE id = p_gasto_id AND tenant_id = v_mp.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;

  -- Guard reuso: el gasto no puede estar ya vinculado a otro mp_movimiento.
  SELECT id INTO v_ya_usado_por
    FROM mp_movimientos
   WHERE justificativo_tipo = 'gasto'
     AND justificativo_id   = p_gasto_id
     AND id <> p_mp_mov_id
   LIMIT 1;
  IF v_ya_usado_por IS NOT NULL THEN
    RAISE EXCEPTION 'JUSTIFICATIVO_YA_USADO';
  END IF;

  v_mp_monto_abs := abs(v_mp.monto);
  v_diff := v_gasto_monto - v_mp_monto_abs;

  -- Warning si la diferencia es > 1 peso. Tolerancia chica para evitar
  -- ruido de redondeos. La tabla 'gastos.monto' está en pesos (no en
  -- centavos) por convención del codebase — round a 2 decimales en el
  -- display final, no acá.
  IF abs(v_diff) > 1.00 THEN
    v_warning := 'Monto del gasto (' || v_gasto_monto::text || ') no coincide con egreso MP ('
                || v_mp_monto_abs::text || '). Diferencia: ' || v_diff::text;
  END IF;

  UPDATE mp_movimientos
     SET justificativo_tipo = 'gasto',
         justificativo_id   = p_gasto_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_GASTO_EXISTENTE', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'gasto_id', p_gasto_id,
    'mp_monto', v_mp_monto_abs, 'gasto_monto', v_gasto_monto,
    'diff', v_diff, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object(
    'mp_mov_id',   p_mp_mov_id,
    'tipo',        'gasto',
    'gasto_id',    p_gasto_id,
    'gasto_monto', v_gasto_monto,
    'mp_monto',    v_mp_monto_abs,
    'diff',        v_diff,
    'warning',     v_warning
  );
END;
$function$;
