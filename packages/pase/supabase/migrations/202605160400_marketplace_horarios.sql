-- ─── Marketplace: horarios apertura/cierre + RPC con cálculo "abierto ahora" ─
-- Agrega 7 columnas (una por día) a comanda_local_settings con strings
-- formato "HH:MM-HH:MM,HH:MM-HH:MM" (múltiples ranges por día separados con
-- coma — caso típico restaurant: 12:00-15:00,20:00-00:30).
--
-- Esquema simple sin tabla aparte porque:
--   - Cada local define sus horarios una vez y rara vez cambia.
--   - Restaurant más complejo (horarios distintos por canal delivery vs
--     retiro) NO está en scope ahora.
--   - Si se necesita más adelante, migración a tabla horarios_local con
--     (dia, desde, hasta, canal) en sprint dedicado.
--
-- La RPC fn_marketplace_listar se actualiza para incluir "abierto_ahora"
-- calculado en Argentina TZ.

ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_lun TEXT NULL;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_mar TEXT NULL;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_mie TEXT NULL;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_jue TEXT NULL;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_vie TEXT NULL;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_sab TEXT NULL;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS horario_dom TEXT NULL;

COMMENT ON COLUMN comanda_local_settings.horario_lun IS
  'Horarios del día en formato "HH:MM-HH:MM[,HH:MM-HH:MM]". NULL = cerrado. Ej: "12:00-15:00,20:00-23:30".';

-- Helper: dado un string "HH:MM-HH:MM,..." y una hora HH:MM, devuelve TRUE si está
-- dentro de algún range. Maneja ranges que cruzan medianoche (ej. 22:00-02:00).
CREATE OR REPLACE FUNCTION fn_horario_abierto(p_horario TEXT, p_hora TIME)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_range TEXT;
  v_desde TIME;
  v_hasta TIME;
BEGIN
  IF p_horario IS NULL OR p_horario = '' THEN RETURN FALSE; END IF;
  FOREACH v_range IN ARRAY string_to_array(p_horario, ',')
  LOOP
    BEGIN
      v_desde := split_part(trim(v_range), '-', 1)::TIME;
      v_hasta := split_part(trim(v_range), '-', 2)::TIME;
      IF v_hasta > v_desde THEN
        IF p_hora >= v_desde AND p_hora < v_hasta THEN RETURN TRUE; END IF;
      ELSE
        -- cruza medianoche
        IF p_hora >= v_desde OR p_hora < v_hasta THEN RETURN TRUE; END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;  -- range mal formado → ignorar
    END;
  END LOOP;
  RETURN FALSE;
END;
$$;

-- Actualizar fn_marketplace_listar para incluir horarios + abierto_ahora
-- (calculado en TZ Argentina) + tiempos de retiro/delivery.
DROP FUNCTION IF EXISTS fn_marketplace_listar();

CREATE OR REPLACE FUNCTION fn_marketplace_listar()
RETURNS TABLE (
  id INTEGER,
  nombre TEXT,
  slug TEXT,
  marketplace_descripcion TEXT,
  marketplace_tags TEXT[],
  marketplace_foto_url TEXT,
  online_modo TEXT,
  tiempo_retiro_min INTEGER,
  tiempo_delivery_min INTEGER,
  abierto_ahora BOOLEAN,
  horario_hoy TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_dia INTEGER;  -- 0=domingo, 1=lunes, ..., 6=sábado (EXTRACT DOW)
  v_hora TIME;
BEGIN
  v_now := NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires';
  v_dia := EXTRACT(DOW FROM v_now)::INTEGER;
  v_hora := v_now::TIME;

  RETURN QUERY
  SELECT
    l.id,
    l.nombre,
    cls.slug,
    l.marketplace_descripcion,
    l.marketplace_tags,
    l.marketplace_foto_url,
    CASE WHEN cls.acepta_delivery THEN 'delivery' ELSE 'retiro' END,
    cls.tiempo_retiro_min,
    cls.tiempo_delivery_min,
    CASE v_dia
      WHEN 0 THEN fn_horario_abierto(cls.horario_dom, v_hora)
      WHEN 1 THEN fn_horario_abierto(cls.horario_lun, v_hora)
      WHEN 2 THEN fn_horario_abierto(cls.horario_mar, v_hora)
      WHEN 3 THEN fn_horario_abierto(cls.horario_mie, v_hora)
      WHEN 4 THEN fn_horario_abierto(cls.horario_jue, v_hora)
      WHEN 5 THEN fn_horario_abierto(cls.horario_vie, v_hora)
      WHEN 6 THEN fn_horario_abierto(cls.horario_sab, v_hora)
      ELSE FALSE
    END AS abierto_ahora,
    CASE v_dia
      WHEN 0 THEN cls.horario_dom
      WHEN 1 THEN cls.horario_lun
      WHEN 2 THEN cls.horario_mar
      WHEN 3 THEN cls.horario_mie
      WHEN 4 THEN cls.horario_jue
      WHEN 5 THEN cls.horario_vie
      WHEN 6 THEN cls.horario_sab
      ELSE NULL
    END AS horario_hoy
  FROM locales l
  JOIN comanda_local_settings cls
    ON cls.local_id = l.id AND cls.deleted_at IS NULL
  WHERE l.visible_marketplace = TRUE
    AND cls.slug IS NOT NULL
    AND cls.tienda_activa = TRUE
  ORDER BY l.nombre ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_marketplace_listar() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_horario_abierto(TEXT, TIME) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
