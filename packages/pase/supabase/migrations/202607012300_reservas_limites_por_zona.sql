-- Límites de comensales por SECTOR (ej. Maneki: Privado 4-6, Mesas Altas máx 2,
-- Barra máx 3). Config JSONB por local: [{zona, min, max}]. El motor solo asigna
-- una mesa/combo de un sector si el grupo entra en el rango de ESE sector.
ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_zonas_limites JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ¿El sector admite un grupo de N? (sin límite configurado → sí)
CREATE OR REPLACE FUNCTION public.fn_zona_admite_personas(
  p_local_id integer, p_zona text, p_personas integer
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT p_personas >= COALESCE((lim->>'min')::int, 0)
                AND p_personas <= COALESCE((lim->>'max')::int, 9999)
       FROM comanda_local_settings cls,
            jsonb_array_elements(COALESCE(cls.reservas_zonas_limites, '[]'::jsonb)) lim
      WHERE cls.local_id = p_local_id AND (lim->>'zona') = p_zona
      LIMIT 1),
    TRUE);
$$;

-- Buscar mesa(s) respetando además los límites por sector.
CREATE OR REPLACE FUNCTION public.fn_buscar_mesas_reserva(
  p_local_id integer, p_inicio timestamptz, p_dur_min integer,
  p_personas integer, p_permite_combinar boolean, p_zona text DEFAULT NULL
)
RETURNS bigint[] LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_mesa bigint; v_par bigint[];
BEGIN
  SELECT m.id INTO v_mesa
  FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC
  LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  IF p_permite_combinar THEN
    SELECT ARRAY[a.id, b.id] INTO v_par
    FROM mesas a
    JOIN mesas b ON b.local_id = a.local_id AND b.id > a.id
    WHERE a.local_id = p_local_id
      AND a.deleted_at IS NULL AND a.reservable
      AND b.deleted_at IS NULL AND b.reservable
      AND (p_zona IS NULL OR (a.zona = p_zona AND b.zona = p_zona))
      AND a.zona IS NOT DISTINCT FROM b.zona
      AND fn_zona_admite_personas(p_local_id, a.zona, p_personas)
      AND COALESCE(a.capacidad,0) + COALESCE(b.capacidad,0) >= p_personas
      AND NOT fn_mesa_ocupada_en(a.id, p_inicio, p_dur_min, NULL)
      AND NOT fn_mesa_ocupada_en(b.id, p_inicio, p_dur_min, NULL)
    ORDER BY (COALESCE(a.capacidad,0) + COALESCE(b.capacidad,0)) ASC, a.id
    LIMIT 1;
    IF v_par IS NOT NULL THEN RETURN v_par; END IF;
  END IF;

  RETURN ARRAY[]::bigint[];
END;
$$;
