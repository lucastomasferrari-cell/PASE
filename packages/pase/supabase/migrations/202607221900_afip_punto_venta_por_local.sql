-- ════════════════════════════════════════════════════════════════════════════
-- AFIP: punto de venta por LOCAL (facturación multi-sucursal)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Contexto: afip_credenciales guarda cert + key + CUIT + UN punto de venta por
-- tenant. Pero un negocio con varios locales bajo el MISMO CUIT tiene un punto
-- de venta DISTINTO por local (regla de AFIP: cada PV numera aparte y está atado
-- a un domicilio). Ej. BETA GASTRONOMICA (Neko): Devoto = PV 6, Maneki = PV 5, etc.
--
-- Solución: el certificado/CUIT/condición siguen compartidos en afip_credenciales
-- (por tenant); el punto de venta pasa a vivir por local en locales.afip_punto_venta.
-- El endpoint /api/afip-cae usa el PV del LOCAL de la venta. Si el local no tiene
-- PV configurado → NO emite (evita facturar con un PV que no es del local).
--
-- Seteo inicial: Neko Devoto (local 3) = PV 6 (RECE web services, Mercedes 3940).
-- Los demás locales quedan en NULL hasta que se configuren (siguen en Maxirest).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE locales
  ADD COLUMN IF NOT EXISTS afip_punto_venta INTEGER
  CHECK (afip_punto_venta IS NULL OR afip_punto_venta > 0);

COMMENT ON COLUMN locales.afip_punto_venta IS
  'Punto de venta AFIP (Web Services) de este local. NULL = el local no factura electrónico. El cert/CUIT viven en afip_credenciales (por tenant).';

-- Neko Devoto → PV 6 (verificado en el listado de puntos de venta de ARCA).
UPDATE locales SET afip_punto_venta = 6 WHERE id = 3 AND nombre = 'Neko Devoto';
