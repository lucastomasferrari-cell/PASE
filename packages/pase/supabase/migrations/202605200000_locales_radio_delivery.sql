-- ═══════════════════════════════════════════════════════════════════════════
-- Fase B (marketplace) — radio de delivery por local
--
-- Sesión 2026-05-18 (roadmap fase B). Hoy el cliente entra a la tienda,
-- escribe cualquier dirección y le aparece "Pagar" habilitado aunque esté
-- a 50 km del local. Resultado: pedidos imposibles que el local tiene
-- que cancelar manualmente + cliente frustrado.
--
-- Fix: agregar radio_delivery_km a locales. Si está NULL → sin límite
-- (default actual). Si tiene valor → el checkout calcula distancia
-- haversine local↔cliente con coords ya guardadas en locales.lat/lon +
-- carrito.direccion_lat/lon. Si excede el radio, bloquea el botón
-- "Pagar" + muestra mensaje "X km del local, máximo Y km".
--
-- Default sugerido (no aplicado): 3-5 km para CABA típico.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE locales
  ADD COLUMN IF NOT EXISTS radio_delivery_km NUMERIC(5,2) NULL
  CHECK (radio_delivery_km IS NULL OR radio_delivery_km > 0);

COMMENT ON COLUMN locales.radio_delivery_km IS
  'Radio máximo de entrega en km. NULL = sin límite. Validado client-side en TiendaCheckout antes de habilitar "Pagar".';

-- Recrear v_locales_publicos para exponer radio_delivery_km al frontend
-- tienda. La vista anterior (migration 202605160600) no lo incluía.
-- DROP CASCADE necesario: CREATE OR REPLACE VIEW no permite cambiar
-- columnas (solo agregar al final).
DROP VIEW IF EXISTS v_locales_publicos CASCADE;
CREATE VIEW v_locales_publicos AS
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
  l.lon,
  l.radio_delivery_km
FROM comanda_local_settings cls
JOIN locales l ON l.id = cls.local_id
WHERE cls.deleted_at IS NULL
  AND cls.tienda_activa = TRUE;

GRANT SELECT ON v_locales_publicos TO anon;
GRANT SELECT ON v_locales_publicos TO authenticated;

NOTIFY pgrst, 'reload schema';
