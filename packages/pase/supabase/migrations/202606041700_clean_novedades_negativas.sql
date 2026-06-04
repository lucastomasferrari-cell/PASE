-- 202606041700_clean_novedades_negativas.sql
-- Lucas 04-jun reportó que tipeando "-1" en faltas (Solana Alessandro Q1 jul)
-- el autosave persistió el valor negativo en DB. Aunque el bug del autosave
-- ya fue eliminado en el commit del mismo día, las filas con valores
-- negativos quedaron en DB y siguen apareciendo al recargar la pantalla.
--
-- Fix: forzar a 0 cualquier valor negativo en TODAS las columnas numéricas
-- de rrhh_novedades. Defensa preventiva — un CHECK constraint a futuro
-- haría esto declarativo, pero por ahora limpiamos las filas existentes.

UPDATE rrhh_novedades SET
  inasistencias = GREATEST(0, COALESCE(inasistencias, 0)),
  horas_extras = GREATEST(0, COALESCE(horas_extras, 0)),
  dobles = GREATEST(0, COALESCE(dobles, 0)),
  feriados = GREATEST(0, COALESCE(feriados, 0)),
  vacaciones_dias = GREATEST(0, COALESCE(vacaciones_dias, 0)),
  otros_descuentos = GREATEST(0, COALESCE(otros_descuentos, 0))
WHERE
  COALESCE(inasistencias, 0) < 0
  OR COALESCE(horas_extras, 0) < 0
  OR COALESCE(dobles, 0) < 0
  OR COALESCE(feriados, 0) < 0
  OR COALESCE(vacaciones_dias, 0) < 0
  OR COALESCE(otros_descuentos, 0) < 0;

-- Hardening: CHECK constraint que prevenga este escenario en el futuro.
-- Si alguna fila no cumple esto post-update, la migration falla — eso es
-- intencional, queremos que el DBA entienda qué pasó.
ALTER TABLE rrhh_novedades
  DROP CONSTRAINT IF EXISTS rrhh_novedades_no_negativos_ck;

ALTER TABLE rrhh_novedades
  ADD CONSTRAINT rrhh_novedades_no_negativos_ck CHECK (
    COALESCE(inasistencias, 0) >= 0
    AND COALESCE(horas_extras, 0) >= 0
    AND COALESCE(dobles, 0) >= 0
    AND COALESCE(feriados, 0) >= 0
    AND COALESCE(vacaciones_dias, 0) >= 0
    AND COALESCE(otros_descuentos, 0) >= 0
  );

COMMENT ON CONSTRAINT rrhh_novedades_no_negativos_ck ON rrhh_novedades IS
  'Bloquea valores negativos en columnas numericas. UI tiene min=0 en NovInput pero esto es defensa-en-profundidad backend (Lucas 04-jun).';

NOTIFY pgrst, 'reload schema';
