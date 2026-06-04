-- 202606042000_rrhh_novedades_hs_extras_negativas.sql
-- Lucas 04-jun: "Hs extras" debe poder ir en NEGATIVO (sirve como ajuste /
-- descuento de horas no trabajadas). El resto de las columnas numéricas de
-- rrhh_novedades siguen sin permitir negativos.
--
-- El cálculo ya soporta horas negativas (calcularHorasExtras acepta negativos
-- desde 2026-05-19). El único bloqueo era el CHECK constraint
-- rrhh_novedades_no_negativos_ck (migración 202606041700), que exigía
-- horas_extras >= 0. Acá lo recreamos quitando esa condición y manteniendo
-- las otras 5 columnas en >= 0.

ALTER TABLE rrhh_novedades
  DROP CONSTRAINT IF EXISTS rrhh_novedades_no_negativos_ck;

ALTER TABLE rrhh_novedades
  ADD CONSTRAINT rrhh_novedades_no_negativos_ck CHECK (
    COALESCE(inasistencias, 0) >= 0
    AND COALESCE(dobles, 0) >= 0
    AND COALESCE(feriados, 0) >= 0
    AND COALESCE(vacaciones_dias, 0) >= 0
    AND COALESCE(otros_descuentos, 0) >= 0
    -- horas_extras: SE PERMITE negativo (ajuste/descuento de horas).
  );

COMMENT ON CONSTRAINT rrhh_novedades_no_negativos_ck ON rrhh_novedades IS
  'Bloquea negativos en columnas numericas EXCEPTO horas_extras, que admite negativos como ajuste de horas (Lucas 04-jun). UI: NovInput con allowNegative solo en Hs extras.';

NOTIFY pgrst, 'reload schema';
