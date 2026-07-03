-- ============================================================
-- 202607031500_reservas_grupos_combinables.sql
-- Combinar mesas por ADYACENCIA (grupos combinables), estilo bar / fila.
--
-- Problema del modelo anterior (combos explícitos): una barra de N banquetas
-- donde cualquier tramo contiguo se junta obliga a enumerar decenas de combos
-- (1+2, 1+2+3, 2+3, 2+3+4, ...). Inviable.
--
-- Ahora: cada fila `reservas_combinaciones` es un GRUPO COMBINABLE: una lista
-- ORDENADA de mesas (mesa_ids) que representan una fila/cluster físico donde
-- las mesas pegadas se pueden unir. El motor, cuando un grupo no entra en una
-- mesa sola, busca el TRAMO CONTIGUO de mesas LIBRES (consecutivas en el orden
-- del grupo) más chico cuya capacidad sumada alcance. La capacidad de cada
-- combinación se calcula sola (suma de las mesas del tramo) → ya no se carga.
--
-- Retrocompatible: un combo viejo de 2-3 mesas es simplemente un grupo corto;
-- el motor lo sigue ofreciendo (ahora además puede usar sub-tramos).
--
-- Sigue: mesa sola primero; grupos solo si p_permite_combinar; fallback de
-- mesa sola relajando el mín del sector.
-- ============================================================

BEGIN;

-- 1) `capacidad` ahora la calcula el motor por tramo → opcional/informativa ──
ALTER TABLE reservas_combinaciones DROP CONSTRAINT IF EXISTS reservas_combinaciones_cap;
ALTER TABLE reservas_combinaciones ALTER COLUMN capacidad DROP NOT NULL;

COMMENT ON TABLE reservas_combinaciones IS
  'Grupos combinables por adyacencia: mesa_ids = fila ordenada de mesas pegables. El motor arma tramos contiguos libres. capacidad es informativa (el motor la calcula por tramo).';
COMMENT ON COLUMN reservas_combinaciones.mesa_ids IS
  'Lista ORDENADA de mesas de la fila/cluster (el orden define la adyacencia: mesa_ids[i] está pegada a mesa_ids[i+1]).';

-- 2) Motor: mesa sola → tramo contiguo libre del grupo → fallback mesa sola ──
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
  arr       bigint[];
  n         integer;
  i         integer;
  j         integer;
  s         integer;
  cap       integer;
  run       bigint[];
  best_ids  bigint[];
  best_cap  integer;
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

  -- 2) GRUPOS COMBINABLES: por cada grupo (fila ordenada), buscar el tramo
  --    contiguo de mesas LIBRES más chico cuya capacidad sumada alcance.
  IF p_permite_combinar THEN
    best_cap := NULL;
    FOR g IN
      SELECT c.mesa_ids AS ids FROM reservas_combinaciones c
      WHERE c.local_id = p_local_id AND c.activa AND c.deleted_at IS NULL
    LOOP
      arr := g.ids;
      n := COALESCE(array_length(arr, 1), 0);
      i := 1;
      WHILE i <= n LOOP
        run := ARRAY[]::bigint[];
        s := 0;
        j := i;
        WHILE j <= n LOOP
          -- ¿arr[j] usable? del local, reservable, no borrada, del sector pedido y LIBRE.
          SELECT COALESCE(m.capacidad, 0) INTO cap FROM mesas m
          WHERE m.id = arr[j] AND m.local_id = p_local_id AND m.deleted_at IS NULL
            AND m.reservable AND (p_zona IS NULL OR m.zona = p_zona);
          IF cap IS NULL OR cap = 0
             OR fn_mesa_ocupada_en(arr[j], p_inicio, p_dur_min, NULL) THEN
            EXIT;  -- corta el tramo contiguo acá (mesa no disponible)
          END IF;
          run := array_append(run, arr[j]);
          s := s + cap;
          IF s >= p_personas THEN
            -- tramo más chico que arranca en i; guardá el mejor global
            -- (menor capacidad; a igualdad, menos mesas).
            IF best_cap IS NULL OR s < best_cap
               OR (s = best_cap AND array_length(run,1) < array_length(best_ids,1)) THEN
              best_cap := s;
              best_ids := run;
            END IF;
            EXIT;
          END IF;
          j := j + 1;
        END LOOP;
        i := i + 1;
      END LOOP;
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
