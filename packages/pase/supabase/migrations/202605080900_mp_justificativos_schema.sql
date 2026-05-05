-- ═══════════════════════════════════════════════════════════════════════════
-- MP justificativos — schema (commit 1/5 de la serie).
--
-- Contexto: el modal "Conciliar egreso MP" en ConciliacionMP.tsx existía
-- pero no tenía botón que lo abriera y, además, intentaba escribir IDs de
-- gastos/facturas (TEXT, prefijados "GASTO-...") en `mp_movimientos.vinculo_id`
-- que está tipado como UUID. Resultado: cero rows con conciliado=true en
-- toda la historia de prod (verificado contra DB el 2026-05-08).
--
-- Esta migration introduce un sistema paralelo de justificativos sobre los
-- mismos rows de mp_movimientos, con tipos enumerados y FK al usuario que
-- justifica. Las columnas viejas (conciliado / vinculo_tipo / vinculo_id /
-- conciliado_at / conciliado_por) se quedan por ahora — ningún código las
-- escribe correctamente, pero borrarlas se difiere a un cleanup posterior
-- para no entrar a tocar la deduplicación de TASK 0.18 en este sprint.
--
-- Decisiones:
--   - justificativo_id es TEXT (no BIGINT, como decía el brief original):
--     gastos.id / movimientos.id / facturas.id / remitos.id en PASE son
--     todos TEXT prefijados ("GASTO-...", "MOV-...", etc.). BIGINT no
--     mappea. La FK no se modela como REFERENCES porque el id apunta a
--     tablas distintas según justificativo_tipo (polimorfismo).
--   - Solo egresos manuales (monto<0, tipo NOT IN ('fee','tax')) requieren
--     justificativo. Comisiones MP (fee) y retenciones (tax) se backfillean
--     como justificativo_tipo='comision_mp' en la migration 3/5.
--   - El CHECK incluye 'retiro_automatico' aunque hoy en prod no existe
--     ningún tipo de movimiento que mapee a eso (no hay `withdrawal` en los
--     últimos 90d). Lo dejamos disponible para cuando MP empiece a
--     reportarlo separado.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE mp_movimientos
  ADD COLUMN IF NOT EXISTS justificativo_tipo TEXT NULL,
  ADD COLUMN IF NOT EXISTS justificativo_id   TEXT NULL,
  ADD COLUMN IF NOT EXISTS justificativo_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS justificativo_por  INTEGER NULL REFERENCES usuarios(id);

-- CHECK con nombre explícito para poder DROPearlo y modificar el set de
-- valores aceptados sin recrear la columna.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mp_movimientos_justificativo_tipo_check'
  ) THEN
    ALTER TABLE mp_movimientos
      ADD CONSTRAINT mp_movimientos_justificativo_tipo_check
      CHECK (justificativo_tipo IS NULL OR justificativo_tipo IN (
        'factura', 'remito', 'gasto', 'egreso_manual',
        'movimiento_interno', 'comision_mp', 'retiro_automatico'
      ));
  END IF;
END$$;

-- Coherencia: si hay tipo, hay id (excepto los autoderivados que no apuntan
-- a una tabla externa: comision_mp y retiro_automatico).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mp_movimientos_justificativo_id_check'
  ) THEN
    ALTER TABLE mp_movimientos
      ADD CONSTRAINT mp_movimientos_justificativo_id_check
      CHECK (
        justificativo_tipo IS NULL
        OR justificativo_tipo IN ('comision_mp', 'retiro_automatico')
        OR justificativo_id IS NOT NULL
      );
  END IF;
END$$;

COMMENT ON COLUMN mp_movimientos.justificativo_tipo IS
  'Categoría del justificativo del egreso: factura/remito/gasto/egreso_manual/'
  'movimiento_interno (manuales) o comision_mp/retiro_automatico (auto). '
  'NULL = todavía no justificado. Sustituye al par conciliado/vinculo_tipo '
  'que nunca llegó a poblarse correctamente.';
COMMENT ON COLUMN mp_movimientos.justificativo_id IS
  'ID en la tabla destino — TEXT porque gastos/facturas/movimientos/remitos '
  'usan ids prefijados ("GASTO-...","MOV-..."). Tabla destino se infiere '
  'de justificativo_tipo. NULL para comision_mp y retiro_automatico.';
COMMENT ON COLUMN mp_movimientos.justificativo_at IS
  'Timestamp del momento de justificación. NULL mientras esté pendiente.';
COMMENT ON COLUMN mp_movimientos.justificativo_por IS
  'Usuario que justificó. FK a usuarios. NULL para automáticos (backfill / '
  'reglas de import) o mientras esté pendiente.';

-- Índice principal: lookup por (tipo, id) — usado por la UI para mostrar
-- "este gasto está vinculado a tal mp_movimiento" y por las RPCs para
-- detectar duplicados de justificación contra el mismo gasto.
CREATE INDEX IF NOT EXISTS idx_mp_mov_justificativo
  ON mp_movimientos (justificativo_tipo, justificativo_id)
  WHERE justificativo_tipo IS NOT NULL;

-- Índice "egresos pendientes de justificar" — query crítica del KPI de header
-- y del filtro "solo sin justificar". Partial index porque el 99% de las
-- filas no aplican (ingresos no requieren justificativo, ya justificadas
-- excluidas).
CREATE INDEX IF NOT EXISTS idx_mp_mov_sin_justificar
  ON mp_movimientos (fecha DESC, local_id)
  WHERE monto < 0 AND anulado = false AND justificativo_tipo IS NULL;
