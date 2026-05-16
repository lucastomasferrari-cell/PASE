-- ─── Marketplace propio: estructura inicial ─────────────────────────────────
-- Agrega columnas a locales para opt-in al marketplace público + RPC
-- pública SECURITY DEFINER que devuelve solo los campos necesarios sin
-- exponer datos sensibles (cuentas, configuración interna, etc.).
--
-- Cuando un dueño activa visible_marketplace para su local, aparece en
-- /marketplace para que cualquier cliente (sin auth) lo descubra y entre
-- a su tienda online existente (/tienda/<slug>).
--
-- Este sprint NO incluye:
-- - Geolocalización / radio de delivery (pendiente)
-- - Rating / reviews (pendiente)
-- - Filtros multi-tenant cross-locales (RLS lo permite vía RPC pública)

ALTER TABLE locales ADD COLUMN IF NOT EXISTS visible_marketplace BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE locales ADD COLUMN IF NOT EXISTS marketplace_descripcion TEXT NULL;
ALTER TABLE locales ADD COLUMN IF NOT EXISTS marketplace_tags TEXT[] NULL;
ALTER TABLE locales ADD COLUMN IF NOT EXISTS marketplace_foto_url TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_locales_marketplace
  ON locales(visible_marketplace) WHERE visible_marketplace = TRUE;

-- RPC pública para listar locales del marketplace. NO requiere auth porque
-- solo devuelve campos curados (nada sensible) y filtra por
-- visible_marketplace=TRUE. La firma evita filtrar por tenant — es feed
-- global cross-tenant intencional.
--
-- IMPORTANTE: slug y tienda_activa viven en comanda_local_settings
-- (separada de locales para que COMANDA no toque schema de PASE), por eso
-- el JOIN. online_modo se deriva de acepta_delivery (no es columna real).
CREATE OR REPLACE FUNCTION fn_marketplace_listar()
RETURNS TABLE (
  id INTEGER,
  nombre TEXT,
  slug TEXT,
  marketplace_descripcion TEXT,
  marketplace_tags TEXT[],
  marketplace_foto_url TEXT,
  online_modo TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id,
    l.nombre,
    cls.slug,
    l.marketplace_descripcion,
    l.marketplace_tags,
    l.marketplace_foto_url,
    CASE WHEN cls.acepta_delivery THEN 'delivery' ELSE 'retiro' END AS online_modo
  FROM locales l
  JOIN comanda_local_settings cls
    ON cls.local_id = l.id AND cls.deleted_at IS NULL
  WHERE l.visible_marketplace = TRUE
    AND cls.slug IS NOT NULL
    AND cls.tienda_activa = TRUE
  ORDER BY l.nombre ASC;
$$;

GRANT EXECUTE ON FUNCTION fn_marketplace_listar() TO anon, authenticated;

-- Recargar el schema cache de PostgREST
NOTIFY pgrst, 'reload schema';
