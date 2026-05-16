-- ─── Local: provincia + localidad (filtro autocomplete direcciones) ────────
-- Sin esto, GeoRef devuelve direcciones de toda Argentina y "Belgrano 1234"
-- te trae Belgrano de Catamarca cuando vos estás en CABA.
--
-- El dueño configura una vez en Settings → Local: "Mi local está en CABA"
-- y el autocomplete del cliente solo trae direcciones de esa provincia.
--
-- Localidad es opcional (más específico): "Mi local está en Belgrano (CABA)".
-- Si se setea, el autocomplete prioriza esa localidad pero igual permite
-- otras de la misma provincia (cliente puede pedir desde Palermo).

ALTER TABLE locales ADD COLUMN IF NOT EXISTS provincia TEXT NULL;
ALTER TABLE locales ADD COLUMN IF NOT EXISTS localidad TEXT NULL;
ALTER TABLE locales ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7) NULL;
ALTER TABLE locales ADD COLUMN IF NOT EXISTS lon NUMERIC(10,7) NULL;

COMMENT ON COLUMN locales.provincia IS 'Nombre exacto de provincia AR (ej: "Ciudad Autónoma de Buenos Aires", "Buenos Aires", "Córdoba"). Usado para filtrar autocomplete de direcciones del cliente.';
COMMENT ON COLUMN locales.localidad IS 'Localidad/partido (ej: "Belgrano", "La Plata"). Opcional, prioriza pero no restringe el autocomplete a esa localidad.';
COMMENT ON COLUMN locales.lat IS 'Latitud del local — para calcular distancia al cliente.';
COMMENT ON COLUMN locales.lon IS 'Longitud del local — para calcular distancia al cliente.';

-- Actualizar fn_marketplace_listar para exponer también provincia/localidad/lat/lon
-- del local (futuro: filtrar marketplace por radio desde el cliente).
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
  horario_hoy TEXT,
  provincia TEXT,
  localidad TEXT,
  lat NUMERIC,
  lon NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_dia INTEGER;
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
    END,
    CASE v_dia
      WHEN 0 THEN cls.horario_dom
      WHEN 1 THEN cls.horario_lun
      WHEN 2 THEN cls.horario_mar
      WHEN 3 THEN cls.horario_mie
      WHEN 4 THEN cls.horario_jue
      WHEN 5 THEN cls.horario_vie
      WHEN 6 THEN cls.horario_sab
      ELSE NULL
    END,
    l.provincia,
    l.localidad,
    l.lat,
    l.lon
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

-- Extender v_locales_publicos para que la tienda online tenga provincia/localidad
-- del local + lat/lon (usados por el autocomplete cliente para filtrar GeoRef).
CREATE OR REPLACE VIEW v_locales_publicos AS
SELECT
  cls.local_id,
  cls.slug,
  l.nombre,
  cls.direccion,
  cls.telefono,
  cls.instagram,
  cls.web,
  cls.mp_qr_url,
  cls.costo_envio_default,
  cls.tiempo_retiro_min,
  cls.tiempo_delivery_min,
  cls.tienda_activa,
  cls.acepta_delivery,
  cls.features_pos_modos,
  l.provincia,
  l.localidad,
  l.lat,
  l.lon
FROM comanda_local_settings cls
JOIN locales l ON l.id = cls.local_id
WHERE cls.deleted_at IS NULL
  AND cls.tienda_activa = TRUE;

NOTIFY pgrst, 'reload schema';
