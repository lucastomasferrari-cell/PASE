-- ============================================================
-- 202607032100_mesas_min_max_por_mesa.sql
-- Mín/máx de personas POR MESA (no por sector), estilo OpenTable/Toast.
--
-- Antes: el cupo mínimo/máximo se definía por sector (reservas_zonas_limites)
-- y el motor lo chequeaba con fn_zona_admite_personas. Lucas: no tiene sentido
-- por sector; lo quiere por mesa.
--
-- Ahora: cada mesa tiene capacidad (= máximo) y min_personas (= mínimo, opcional,
-- default 1). El motor asigna una mesa sola si min <= personas <= capacidad.
-- El fallback ignora el mínimo (para no dejar a nadie sin lugar). Los combos
-- (grupo/fija) quedan igual. fn_zona_admite_personas queda sin uso (no molesta).
-- ============================================================

BEGIN;

ALTER TABLE mesas ADD COLUMN IF NOT EXISTS min_personas INTEGER;
COMMENT ON COLUMN mesas.min_personas IS 'Mínimo de personas para asignar esta mesa sola (opcional, default 1). El máximo es capacidad.';

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
    FOR g IN
      SELECT c.mesa_ids AS ids FROM reservas_combinaciones c
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
          SELECT COALESCE(m.capacidad, 0) INTO cap FROM mesas m
          WHERE m.id = arr[j] AND m.local_id = p_local_id AND m.deleted_at IS NULL
            AND m.reservable AND (p_zona IS NULL OR m.zona = p_zona);
          IF cap IS NULL OR cap = 0
             OR fn_mesa_ocupada_en(arr[j], p_inicio, p_dur_min, NULL) THEN
            EXIT;
          END IF;
          run := array_append(run, arr[j]);
          s := s + cap;
          IF s >= p_personas THEN
            IF best_cap IS NULL OR s < best_cap
               OR (s = best_cap AND array_length(run,1) < best_n) THEN
              best_cap := s; best_ids := run; best_n := array_length(run,1);
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

  -- 3) FALLBACK: mesa sola ignorando el mínimo (para no dejar a nadie sin lugar).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND p_personas <= COALESCE(m.capacidad, 9999)
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC NULLS LAST, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  RETURN ARRAY[]::bigint[];
END; $function$;

COMMIT;
