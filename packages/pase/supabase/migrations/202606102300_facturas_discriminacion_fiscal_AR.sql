-- 202606102300_facturas_discriminacion_fiscal_AR.sql
-- Lucas 10-jun: "el contador necesita que esté todo lo más discriminado
-- posible, no solo para esta cosa sino para todo".
--
-- El esquema actual guarda neto/iva21/iva105/iibb/perc_iva/otros_cargos/
-- descuentos. Para un contador AR profesional faltan:
--   1) Bases distintas: no_gravado, exento (algunas facturas mixtas)
--   2) IVA 27% (telco, servicios específicos)
--   3) IIBB desglosado por jurisdicción (CABA, BsAs, otros) — hoy hay UN
--      solo campo iibb plano que no discrimina. El contador presenta los
--      libros IVA con percepciones SEPARADAS por provincia.
--   4) Percepción Ganancias (RG 830) — retención AFIP
--   5) Retención SUSS — para servicios profesionales/honorarios
--
-- Estrategia (todo ADDITIVE):
--   - 9 columnas nuevas con DEFAULT 0, no rompe nada existente
--   - Backfill: el `iibb` legacy (que era una bolsa plana) queda como
--     `iibb_otros` para que el contador pueda re-asignar manualmente a
--     CABA o BsAs según le toque. Mejor opción que "asumir" CABA por defecto
--   - `iibb_otros_jurisdiccion` (text libre): "Córdoba", "Mendoza" para los
--     casos de jurisdicciones poco frecuentes. NULL = legacy sin discriminar
--   - El campo legacy `iibb` queda como CACHE de la suma (CABA+BsAs+otros)
--     mantenido por el FE — no se elimina para no romper queries antiguas

ALTER TABLE facturas
  ADD COLUMN IF NOT EXISTS iva27       numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_gravado  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exento      numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iibb_caba   numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iibb_ba     numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iibb_otros  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS iibb_otros_jurisdiccion text,
  ADD COLUMN IF NOT EXISTS perc_ganancias numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retencion_suss numeric DEFAULT 0;

COMMENT ON COLUMN facturas.iva27 IS 'IVA 27% (telefonía, algunos servicios específicos).';
COMMENT ON COLUMN facturas.no_gravado IS 'Base no gravada (ej: parte de la factura sin IVA por exención subjetiva).';
COMMENT ON COLUMN facturas.exento IS 'Base exenta (ej: alimentos exentos, libros, ciertos servicios médicos).';
COMMENT ON COLUMN facturas.iibb_caba IS 'Percepción IIBB jurisdicción CABA discriminada.';
COMMENT ON COLUMN facturas.iibb_ba IS 'Percepción IIBB jurisdicción Provincia de Buenos Aires discriminada.';
COMMENT ON COLUMN facturas.iibb_otros IS 'Percepción IIBB en otra jurisdicción (ver columna iibb_otros_jurisdiccion para detalle). Las facturas viejas tienen aquí el legacy iibb plano para que el contador pueda re-asignar.';
COMMENT ON COLUMN facturas.iibb_otros_jurisdiccion IS 'Texto libre con la jurisdicción del IIBB otros (ej: Córdoba, Mendoza). NULL si era legacy sin discriminar.';
COMMENT ON COLUMN facturas.perc_ganancias IS 'Retención Ganancias (RG 830 AFIP).';
COMMENT ON COLUMN facturas.retencion_suss IS 'Retención de Seguridad Social (servicios profesionales).';
COMMENT ON COLUMN facturas.iibb IS 'TOTAL Percepción IIBB. Cache de iibb_caba + iibb_ba + iibb_otros. Se mantiene desde el FE para compat con queries históricas.';

-- Backfill: las facturas existentes tienen iibb plano sin desglosar.
-- Las pasamos a iibb_otros con jurisdicción NULL para señalar "legacy".
-- El contador puede después editar y re-asignar a CABA/BsAs si corresponde.
-- Solo backfileamos las que realmente tienen iibb > 0 (la mayoría está en 0).
UPDATE facturas
SET iibb_otros = iibb
WHERE iibb > 0
  AND iibb_caba = 0 AND iibb_ba = 0 AND iibb_otros = 0;

NOTIFY pgrst, 'reload schema';
