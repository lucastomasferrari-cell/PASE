-- 202606182400_fn_recolocar_mov_fecha.sql
-- Conciliación: "traer un pago a este mes". Cuando un pago se cargó en PASE con
-- una fecha de otro mes (típico: lo cargaste días después de la transferencia
-- real), el cruce lo muestra como "alerta" (fuera del período pero coincide por
-- monto). Esta RPC corrige la fecha del movimiento a la fecha real de la
-- transferencia del extracto, para que entre en el cruce del mes correcto.
-- Solo cambia la fecha: el saldo es Σ importes, no depende de la fecha.
-- Permiso: dueño/admin o quien tenga el módulo conciliación. Audita el cambio.

CREATE OR REPLACE FUNCTION public.fn_recolocar_mov_fecha(p_mov_id text, p_nueva_fecha date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_mov    RECORD;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('conciliacion')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;
  IF p_nueva_fecha IS NULL THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;

  SELECT * INTO v_mov FROM movimientos
  WHERE id = p_mov_id AND tenant_id = v_tenant
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado THEN RAISE EXCEPTION 'MOVIMIENTO_ANULADO'; END IF;
  IF v_mov.conciliado_corrida_id IS NOT NULL THEN RAISE EXCEPTION 'MOVIMIENTO_YA_CONCILIADO'; END IF;
  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
     SET fecha = p_nueva_fecha,
         editado = true,
         editado_motivo = 'Fecha re-colocada a la transferencia real del extracto (conciliación): de '
                          || v_mov.fecha::text || ' a ' || p_nueva_fecha::text || '.',
         editado_at = now()
   WHERE id = p_mov_id;

  RETURN jsonb_build_object(
    'mov_id', p_mov_id,
    'fecha_anterior', v_mov.fecha,
    'fecha_nueva', p_nueva_fecha
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
