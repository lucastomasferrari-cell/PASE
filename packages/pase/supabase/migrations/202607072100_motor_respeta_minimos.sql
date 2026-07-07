-- ============================================================
-- 202607072100_motor_respeta_minimos.sql
-- El motor de reservas RESPETA LOS MÍNIMOS SIEMPRE (pedido explícito de Lucas
-- tras detectar reservas de 2-3 personas cayendo en el Privado de sillones de 6).
--
-- Dos cambios en fn_buscar_mesas_reserva:
--   1) GRUPOS (paso 2a): un tramo contiguo NO puede incluir una mesa cuyo
--      min_personas sea mayor que las personas de la reserva. Así el grupo
--      "Privado" (sillones min 4) nunca se ofrece para grupos de menos de 4.
--   2) Se ELIMINA el fallback blando (paso 3) que asignaba cualquier mesa con
--      capacidad ignorando el mínimo. Ahora, si no hay mesa/combinación que
--      respete el mínimo, devuelve "sin mesa" (se maneja a mano). El mínimo es
--      DURO en todos los casos.
--
-- Las fijas (paso 2b) ya respetan su propio rango min/max — no se tocan.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_buscar_mesas_reserva(
  p_local_id integer, p_inicio timestamp with time zone, p_dur_min integer,
  p_personas integer, p_permite_combinar boolean, p_zona text DEFAULT NULL::text
)
RETURNS bigint[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_mesa    bigint;
  g         RECORD;
  f         RECORD;
  arr       bigint[];
  n         integer;
  i         integer;
  j         integer;
  s         integer;
  cap       integer;
  v_min     integer;
  run       bigint[];
  best_ids  bigint[];
  best_cap  integer;
  best_n    integer;
BEGIN
  -- 1) Mejor mesa individual: respeta el mín Y máx de la propia mesa.
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND p_personas >= COALESCE(m.min_personas, 1)
    AND p_personas <= COALESCE(m.capacidad, 9999)
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC NULLS LAST, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  IF p_permite_combinar THEN
    best_cap := NULL; best_ids := NULL; best_n := NULL;

    -- 2a) GRUPOS: tramo contiguo de mesas libres más chico que alcance.
    --     Respeta el mínimo: no incluye una mesa cuyo min_personas supere las
    --     personas de la reserva (ej. sillones min 4 no toman grupos de 3).
    --     Y respeta max_sillas_vacias para no desperdiciar.
    FOR g IN
      SELECT c.mesa_ids AS ids, c.max_sillas_vacias AS max_vacias
      FROM reservas_combinaciones c
      WHERE c.local_id = p_local_id AND c.activa AND c.deleted_at IS NULL AND c.tipo = 'grupo'
    LOOP
      arr := g.ids;
      n := COALESCE(array_length(arr, 1), 0);
      i := 1;
      WHILE i <= n LOOP
        run := ARRAY[]::bigint[];
        s := 0;
        j := i;
        WHILE j <= n LOOP
          SELECT COALESCE(m.capacidad, 0), COALESCE(m.min_personas, 1)
            INTO cap, v_min FROM mesas m
          WHERE m.id = arr[j] AND m.local_id = p_local_id AND m.deleted_at IS NULL
            AND m.reservable AND (p_zona IS NULL OR m.zona = p_zona);
          -- Corta el tramo si la mesa no sirve: sin capacidad, ocupada, o el
          -- mínimo de la mesa es mayor que las personas de la reserva.
          IF cap IS NULL OR cap = 0
             OR p_personas < v_min
             OR fn_mesa_ocupada_en(arr[j], p_inicio, p_dur_min, NULL) THEN
            EXIT;
          END IF;
          run := array_append(run, arr[j]);
          s := s + cap;
          IF s >= p_personas THEN
            IF g.max_vacias IS NULL OR (s - p_personas) <= g.max_vacias THEN
              IF best_cap IS NULL OR s < best_cap
                 OR (s = best_cap AND array_length(run,1) < best_n) THEN
                best_cap := s; best_ids := run; best_n := array_length(run,1);
              END IF;
            END IF;
            EXIT;
          END IF;
          j := j + 1;
        END LOOP;
        i := i + 1;
      END LOOP;
    END LOOP;

    -- 2b) FIJAS: combinación exacta si el grupo entra en su rango y todas libres.
    FOR f IN
      SELECT c.mesa_ids AS ids, c.min_personas AS mn, c.max_personas AS mx
      FROM reservas_combinaciones c
      WHERE c.local_id = p_local_id AND c.activa AND c.deleted_at IS NULL AND c.tipo = 'fija'
    LOOP
      IF EXISTS (
        SELECT 1 FROM unnest(f.ids) mid
        WHERE NOT EXISTS (
          SELECT 1 FROM mesas m
          WHERE m.id = mid AND m.local_id = p_local_id AND m.deleted_at IS NULL
            AND m.reservable AND (p_zona IS NULL OR m.zona = p_zona))
      ) THEN CONTINUE; END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(f.ids) mid
        WHERE fn_mesa_ocupada_en(mid, p_inicio, p_dur_min, NULL)
      ) THEN CONTINUE; END IF;
      SELECT COALESCE(SUM(m.capacidad), 0) INTO s FROM mesas m WHERE m.id = ANY(f.ids);
      IF p_personas < COALESCE(f.mn, 1) OR p_personas > COALESCE(f.mx, s) THEN
        CONTINUE;
      END IF;
      cap := COALESCE(f.mx, s);
      IF best_cap IS NULL OR cap < best_cap
         OR (cap = best_cap AND COALESCE(array_length(f.ids,1),0) < best_n) THEN
        best_cap := cap; best_ids := f.ids; best_n := COALESCE(array_length(f.ids,1),0);
      END IF;
    END LOOP;

    IF best_ids IS NOT NULL AND array_length(best_ids, 1) >= 1 THEN
      RETURN best_ids;
    END IF;
  END IF;

  -- 3) Sin fallback que viole el mínimo: si nada respetó el mínimo, sin mesa.
  RETURN ARRAY[]::bigint[];
END; $function$;

COMMIT;
