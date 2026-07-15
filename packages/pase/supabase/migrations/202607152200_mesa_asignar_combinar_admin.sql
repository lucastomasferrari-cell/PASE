-- MESA · admin: asignar COMBINACIÓN de mesas + auto-asignar desde el panel.
--
-- Contexto (feedback real de la operación, 15-jul): desde el admin de MESA solo
-- se podía asignar UNA mesa por reserva (`fn_asignar_mesa_reserva` pisa mesas_ids
-- con ARRAY[una]). El motor que combina banquetas (`fn_buscar_mesas_reserva`)
-- solo corría en la creación PÚBLICA. Resultado: para una reserva de barra que
-- necesita 2 banquetas, el staff no podía combinarlas a mano → workaround feo de
-- crear 2 reservas de 1 persona.
--
-- Esta migración da dos caminos al panel, reusando la lógica ya probada:
--   1) fn_asignar_mesas_reserva(id, mesa_ids[]) — asignación manual de un conjunto.
--   2) fn_autoasignar_mesa_reserva(id)          — el motor elige (y combina) la mejor.
-- Y `fn_asignar_mesa_reserva` (singular) pasa a ser un wrapper del plural, para
-- que exista una sola fuente de verdad de validación (cap dura, ocupación, local,
-- permiso por local). Códigos de error idénticos (el harness/frontend los mapean).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Asignación MANUAL de una o varias mesas (fuente de verdad de validación).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_asignar_mesas_reserva(
  p_reserva_id bigint,
  p_mesa_ids   bigint[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant     uuid := auth_tenant_id();
  v_r          reservas%ROWTYPE;
  v_ids        bigint[];
  v_local_mesa integer;
  v_cap_total  integer;
  v_m          bigint;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF v_r.estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ASIGNABLE: estado=%', v_r.estado;
  END IF;

  -- Dedup preservando el orden de primera aparición (mesa_id "primaria" = la 1ª).
  SELECT array_agg(x ORDER BY ord) INTO v_ids
  FROM (
    SELECT x, MIN(ord) AS ord
    FROM unnest(p_mesa_ids) WITH ORDINALITY AS t(x, ord)
    WHERE x IS NOT NULL
    GROUP BY x
  ) s;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'MESA_IDS_REQUERIDAS';
  END IF;

  -- Cada mesa debe existir (no borrada) y ser del MISMO local de la reserva.
  FOREACH v_m IN ARRAY v_ids LOOP
    SELECT local_id INTO v_local_mesa FROM mesas WHERE id = v_m AND deleted_at IS NULL;
    IF v_local_mesa IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
    IF v_local_mesa <> v_r.local_id THEN RAISE EXCEPTION 'MESA_OTRO_LOCAL'; END IF;
  END LOOP;

  -- CAP DURO: la suma de capacidades debe alcanzar. El mínimo NO se valida acá:
  -- el admin decide (ej. sentar 2 en un sillón de 6, o combinar de más).
  SELECT COALESCE(SUM(COALESCE(capacidad, 0)), 0) INTO v_cap_total
  FROM mesas WHERE id = ANY(v_ids) AND deleted_at IS NULL;
  IF v_r.personas > v_cap_total THEN
    RAISE EXCEPTION 'MESA_SIN_CAPACIDAD: mesa(s) cap=% personas=%', v_cap_total, v_r.personas;
  END IF;

  -- Serializar contra otras asignaciones del mismo local y chequear ocupación.
  PERFORM pg_advisory_xact_lock(v_r.local_id::bigint);
  FOREACH v_m IN ARRAY v_ids LOOP
    IF fn_mesa_ocupada_en(v_m, v_r.fecha_hora, COALESCE(v_r.duracion_min, 90), v_r.id) THEN
      RAISE EXCEPTION 'MESA_OCUPADA';
    END IF;
  END LOOP;

  UPDATE reservas
     SET mesa_id = v_ids[1], mesas_ids = v_ids, updated_at = NOW()
   WHERE id = p_reserva_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Singular = wrapper del plural (una sola fuente de validación).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_asignar_mesa_reserva(
  p_reserva_id bigint,
  p_mesa_id    bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM fn_asignar_mesas_reserva(p_reserva_id, ARRAY[p_mesa_id]);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Auto-asignar: el motor elige (y combina) la mejor mesa/tramo libre.
--    Reusa fn_buscar_mesas_reserva (mismo criterio que la web pública).
--    Devuelve el array asignado. Busca en CUALQUIER zona (la reserva no tiene
--    zona fija en el panel) — el motor prioriza menor capacidad ociosa.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_autoasignar_mesa_reserva(
  p_reserva_id bigint
) RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant   uuid := auth_tenant_id();
  v_r        reservas%ROWTYPE;
  v_dur      integer;
  v_combinar boolean;
  v_mesas    bigint[];
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF v_r.estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_ASIGNABLE: estado=%', v_r.estado;
  END IF;

  v_dur := COALESCE(v_r.duracion_min, fn_duracion_reserva_default(v_r.local_id, v_r.personas), 90);
  SELECT COALESCE(reservas_permite_combinar, TRUE) INTO v_combinar
    FROM comanda_local_settings WHERE local_id = v_r.local_id;
  v_combinar := COALESCE(v_combinar, TRUE);

  PERFORM pg_advisory_xact_lock(v_r.local_id::bigint);

  -- Soltar la mesa propia ANTES de buscar, para que el motor no la vea "ocupada
  -- por sí misma" (fn_buscar_mesas_reserva no puede excluir la reserva actual).
  -- Si no hay mesa libre, el RAISE aborta y revierte este UPDATE — la reserva
  -- conserva la mesa que tenía.
  UPDATE reservas SET mesa_id = NULL, mesas_ids = NULL WHERE id = p_reserva_id;

  v_mesas := fn_buscar_mesas_reserva(v_r.local_id, v_r.fecha_hora, v_dur, v_r.personas, v_combinar, NULL);
  IF v_mesas IS NULL OR array_length(v_mesas, 1) IS NULL THEN
    RAISE EXCEPTION 'SIN_MESA';
  END IF;

  UPDATE reservas
     SET mesa_id = v_mesas[1], mesas_ids = v_mesas, updated_at = NOW()
   WHERE id = p_reserva_id;

  RETURN v_mesas;
END;
$function$;

-- Permisos: solo usuarios autenticados (RLS/tenant lo filtra adentro). Nunca anon.
REVOKE ALL ON FUNCTION public.fn_asignar_mesas_reserva(bigint, bigint[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_autoasignar_mesa_reserva(bigint)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_asignar_mesas_reserva(bigint, bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_autoasignar_mesa_reserva(bigint)        TO authenticated;
