-- ============================================================
-- 202607031800_reservas_combinar_dos_modos.sql
-- Combinar mesas con DOS modos (como Eat App), a elección del dueño:
--
--   'grupo' — marcás un conjunto de mesas que se pueden juntar (una fila/barra).
--             El motor arma el TRAMO CONTIGUO de mesas libres más chico que
--             alcance (adyacencia por el orden de mesa_ids). Capacidad = suma.
--
--   'fija'  — combinación EXACTA de mesas puntuales, con rango desde/hasta
--             personas (min_personas / max_personas). El motor la ofrece si el
--             grupo entra en el rango y TODAS sus mesas están libres.
--
-- El motor: mesa sola → mejor 'grupo' → mejor 'fija' → fallback mesa sola.
-- Elige, entre todos los candidatos, el de menor capacidad (a igualdad, menos
-- mesas). Sigue gateado por p_permite_combinar.
-- ============================================================

BEGIN;

-- 1) Columnas de modo ────────────────────────────────────────────────────────
ALTER TABLE reservas_combinaciones
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'grupo',
  ADD COLUMN IF NOT EXISTS min_personas INTEGER,
  ADD COLUMN IF NOT EXISTS max_personas INTEGER;

ALTER TABLE reservas_combinaciones DROP CONSTRAINT IF EXISTS reservas_combinaciones_tipo_chk;
ALTER TABLE reservas_combinaciones
  ADD CONSTRAINT reservas_combinaciones_tipo_chk CHECK (tipo IN ('grupo', 'fija'));

COMMENT ON COLUMN reservas_combinaciones.tipo IS
  'grupo = conjunto que se auto-combina por adyacencia (tramo contiguo libre). fija = combinación exacta con rango min/max.';
COMMENT ON COLUMN reservas_combinaciones.min_personas IS 'Solo tipo=fija: mínimo de personas para ofrecer la combinación (default 1).';
COMMENT ON COLUMN reservas_combinaciones.max_personas IS 'Solo tipo=fija: máximo de personas (default = suma de capacidades de sus mesas).';

-- 2) Motor ───────────────────────────────────────────────────────────────────
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
  -- 1) Mejor mesa individual (respeta mín Y máx del sector).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
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
      -- todas las mesas: del local, reservables, no borradas, del sector pedido.
      IF EXISTS (
        SELECT 1 FROM unnest(f.ids) mid
        WHERE NOT EXISTS (
          SELECT 1 FROM mesas m
          WHERE m.id = mid AND m.local_id = p_local_id AND m.deleted_at IS NULL
            AND m.reservable AND (p_zona IS NULL OR m.zona = p_zona))
      ) THEN CONTINUE; END IF;
      -- ninguna ocupada en la ventana.
      IF EXISTS (
        SELECT 1 FROM unnest(f.ids) mid
        WHERE fn_mesa_ocupada_en(mid, p_inicio, p_dur_min, NULL)
      ) THEN CONTINUE; END IF;
      -- capacidad = suma de las mesas; el rango efectivo usa min/max con defaults.
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

  -- 3) FALLBACK: mesa sola relajando el mín del sector (solo respeta máx).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas, TRUE)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  RETURN ARRAY[]::bigint[];
END; $function$;

COMMIT;
