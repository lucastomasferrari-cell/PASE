-- Fallback de zona: cuando ningún sector acepta el grupo por su mín (ej. grupo
-- de 3, Barra llena, Privado min=4), relajar el mín y buscar una mesa individual
-- donde el grupo entre por capacidad Y personas <= max del sector.
-- Así un grupo de 3 cae al Privado (sillón cap=6, max=6) en vez de dar LLENO.

-- Overload de fn_zona_admite_personas con p_solo_max: ignora el mín del sector.
CREATE OR REPLACE FUNCTION public.fn_zona_admite_personas(
  p_local_id integer, p_zona text, p_personas integer, p_solo_max boolean
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT (p_solo_max OR p_personas >= COALESCE((lim->>'min')::int, 0))
                AND p_personas <= COALESCE((lim->>'max')::int, 9999)
       FROM comanda_local_settings cls,
            jsonb_array_elements(COALESCE(cls.reservas_zonas_limites, '[]'::jsonb)) lim
      WHERE cls.local_id = p_local_id AND (lim->>'zona') = p_zona
      LIMIT 1),
    TRUE);
$$;

-- fn_buscar_mesas_reserva: paso 3 fallback (relajar min del sector).
CREATE OR REPLACE FUNCTION public.fn_buscar_mesas_reserva(
  p_local_id integer, p_inicio timestamptz, p_dur_min integer,
  p_personas integer, p_permite_combinar boolean, p_zona text DEFAULT NULL
)
RETURNS bigint[] LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_mesa bigint; v_ids bigint[] := ARRAY[]::bigint[]; v_suma int := 0;
  v_zona text; r RECORD;
BEGIN
  -- 1) Mejor mesa individual (respeta min Y max del sector).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  IF p_permite_combinar THEN
    -- 2) Combinar dentro de un sector (respeta min Y max).
    v_zona := p_zona;
    IF v_zona IS NULL THEN
      SELECT m.zona INTO v_zona FROM mesas m
      WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
        AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
        AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
      ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
    END IF;
    IF v_zona IS NOT NULL AND fn_zona_admite_personas(p_local_id, v_zona, p_personas) THEN
      FOR r IN
        SELECT m.id, COALESCE(m.capacidad,0) cap FROM mesas m
        WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable AND m.zona = v_zona
          AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
        ORDER BY m.capacidad ASC, m.id ASC
      LOOP
        v_ids := array_append(v_ids, r.id); v_suma := v_suma + r.cap;
        IF v_suma >= p_personas THEN RETURN v_ids; END IF;
        IF array_length(v_ids,1) >= 4 THEN EXIT; END IF;
      END LOOP;
    END IF;
  END IF;

  -- 3) FALLBACK: relajar el mín del sector (solo respetar max).
  --    Barra llena + grupo de 3 → Privado (min=4 ignorado, max=6, sillón cap=6).
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas, TRUE)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  RETURN ARRAY[]::bigint[];
END; $$;
