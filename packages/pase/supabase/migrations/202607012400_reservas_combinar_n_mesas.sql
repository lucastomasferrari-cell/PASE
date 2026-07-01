-- Combinar MÁS de 2 mesas (para barras con banquetas de 1: un grupo de 3 toma
-- 3 asientos adyacentes). fn_buscar_mesas_reserva: 1) mejor mesa individual;
-- 2) si no entra, acumula mesas libres del mismo sector (greedy, menor primero)
-- hasta cubrir el grupo, tope 4 mesas. Respeta límites por sector.
CREATE OR REPLACE FUNCTION public.fn_buscar_mesas_reserva(
  p_local_id integer, p_inicio timestamptz, p_dur_min integer,
  p_personas integer, p_permite_combinar boolean, p_zona text DEFAULT NULL
)
RETURNS bigint[] LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_mesa bigint; v_ids bigint[] := ARRAY[]::bigint[]; v_suma int := 0;
  v_zona text; r RECORD;
BEGIN
  -- 1) Mejor mesa individual que entre.
  SELECT m.id INTO v_mesa FROM mesas m
  WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
    AND COALESCE(m.capacidad,0) >= p_personas
    AND (p_zona IS NULL OR m.zona = p_zona)
    AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
    AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
  ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  IF v_mesa IS NOT NULL THEN RETURN ARRAY[v_mesa]; END IF;

  IF NOT p_permite_combinar THEN RETURN ARRAY[]::bigint[]; END IF;

  -- 2) Combinar dentro de un sector. Si no se pidió sector, tomar el de la
  -- mesa libre más chica que admita el grupo.
  v_zona := p_zona;
  IF v_zona IS NULL THEN
    SELECT m.zona INTO v_zona FROM mesas m
    WHERE m.local_id = p_local_id AND m.deleted_at IS NULL AND m.reservable
      AND fn_zona_admite_personas(p_local_id, m.zona, p_personas)
      AND NOT fn_mesa_ocupada_en(m.id, p_inicio, p_dur_min, NULL)
    ORDER BY m.capacidad ASC, m.id ASC LIMIT 1;
  END IF;
  IF v_zona IS NULL OR NOT fn_zona_admite_personas(p_local_id, v_zona, p_personas) THEN
    RETURN ARRAY[]::bigint[];
  END IF;

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

  RETURN ARRAY[]::bigint[];
END; $$;
