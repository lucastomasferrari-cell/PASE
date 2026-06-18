-- 202606182200_fn_reabrir_conciliacion.sql
-- Reabrir una conciliación cerrada (corrida). Deshace lo que hace
-- fn_cerrar_conciliacion: libera los movimientos (conciliado_corrida_id=NULL),
-- borra el snapshot de items y borra la corrida. Queda como si nunca se hubiera
-- cerrado → el usuario corrige y vuelve a cerrar (se crea una corrida nueva).
-- Los alias aprendidos NO se borran (son conocimiento acumulado, inofensivo).
-- Solo dueño/admin. Atómico.

CREATE OR REPLACE FUNCTION public.fn_reabrir_conciliacion(p_corrida_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
  v_local_id integer;
  v_movs int;
  v_items int;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;

  SELECT local_id INTO v_local_id
  FROM conciliacion_corridas
  WHERE id = p_corrida_id AND tenant_id = v_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CORRIDA_NO_ENCONTRADA'; END IF;

  -- 1. Liberar los movimientos que habían quedado marcados con esta corrida.
  UPDATE movimientos SET conciliado_corrida_id = NULL
  WHERE conciliado_corrida_id = p_corrida_id AND tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_movs = ROW_COUNT;

  -- 2. Borrar el snapshot de items del extracto.
  DELETE FROM conciliacion_extracto_items
  WHERE corrida_id = p_corrida_id AND tenant_id = v_tenant_id;
  GET DIAGNOSTICS v_items = ROW_COUNT;

  -- 3. Borrar la corrida.
  DELETE FROM conciliacion_corridas
  WHERE id = p_corrida_id AND tenant_id = v_tenant_id;

  RETURN jsonb_build_object(
    'corrida_id', p_corrida_id,
    'local_id', v_local_id,
    'movs_liberados', v_movs,
    'items_borrados', v_items
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
