-- 202606022000_fix_empleados_sin_relacion_locales.sql
-- BUG FIX (2026-06-02 noche): empleados creados desde 20-may no tienen
-- fila en `rrhh_empleado_locales` (tabla puente del sprint multilocal),
-- porque `RRHH.tsx::guardarEmp` solo hacía INSERT en `rrhh_empleados`
-- sin poblar la tabla puente.
--
-- Síntoma: `v_rrhh_empleados_visible` devuelve `locales_ids = []` para
-- esos empleados. El filtro client-side en /gastos (tipo=Empleados)
-- los descarta → dropdown vacío en locales como Rene Cantina aunque
-- /equipo SÍ los muestre (lee `rrhh_empleados.local_id` directo).
--
-- 3 fixes en esta migration:
--   1. BACKFILL: para cada empleado SIN fila principal en
--      rrhh_empleado_locales, crear una con su local_id actual.
--   2. TRIGGER AFTER INSERT: cualquier alta futura por cualquier path
--      (UI vieja, UI nueva, script, import bulk) crea automáticamente
--      la fila en la tabla puente.
--   3. TRIGGER AFTER UPDATE OF local_id: si alguien cambia el local
--      principal de un empleado, mantenemos la tabla puente alineada
--      (marca el viejo `es_principal=FALSE`, crea/marca el nuevo como
--      `es_principal=TRUE`).
--
-- No requiere cambios en frontend. El UI `RRHH.tsx::guardarEmp` queda
-- como está — el trigger se encarga.

-- ─── 1. BACKFILL ──────────────────────────────────────────────────────────
-- Reusa el patrón del backfill original (migration 202605204100) pero
-- aplica a empleados creados entre 20-may y ahora.
INSERT INTO rrhh_empleado_locales (
  tenant_id, empleado_id, local_id, es_principal, tipo, fecha_desde
)
SELECT
  e.tenant_id, e.id, e.local_id, TRUE, 'asignado',
  COALESCE(e.fecha_inicio, CURRENT_DATE - INTERVAL '1 year')::DATE
FROM rrhh_empleados e
WHERE e.local_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM rrhh_empleado_locales rel
    WHERE rel.empleado_id = e.id
      AND rel.es_principal = TRUE
      AND rel.deleted_at IS NULL
  )
ON CONFLICT (empleado_id, local_id) DO NOTHING;

-- ─── 2. TRIGGER AFTER INSERT ──────────────────────────────────────────────
-- Cada empleado nuevo dispara fila principal en la tabla puente.
-- Idempotente: si por alguna razón ya existe la fila (ej. la UI fue
-- updateada y mandó las 2 cosas), no falla — ON CONFLICT DO NOTHING.

CREATE OR REPLACE FUNCTION fn_trg_empleado_sync_locales_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.local_id IS NOT NULL THEN
    INSERT INTO rrhh_empleado_locales (
      tenant_id, empleado_id, local_id, es_principal, tipo, fecha_desde
    ) VALUES (
      NEW.tenant_id, NEW.id, NEW.local_id, TRUE, 'asignado',
      COALESCE(NEW.fecha_inicio, CURRENT_DATE)
    )
    ON CONFLICT (empleado_id, local_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_empleado_sync_locales_insert ON rrhh_empleados;
CREATE TRIGGER trg_empleado_sync_locales_insert
  AFTER INSERT ON rrhh_empleados
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_empleado_sync_locales_insert();

-- ─── 3. TRIGGER AFTER UPDATE OF local_id ──────────────────────────────────
-- Si alguien cambia rrhh_empleados.local_id (cambio de sucursal del
-- empleado), reflejamos en la tabla puente:
--   - Marcar `es_principal=FALSE` para la antigua relación principal
--     (sin borrarla — queda como histórico).
--   - INSERT (o reactivar) fila principal para el nuevo local.

CREATE OR REPLACE FUNCTION fn_trg_empleado_sync_locales_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo actuar si cambió el local_id
  IF NEW.local_id IS DISTINCT FROM OLD.local_id THEN
    -- Quitar es_principal de la(s) antigua(s) principal(es)
    UPDATE rrhh_empleado_locales
       SET es_principal = FALSE,
           updated_at = NOW()
     WHERE empleado_id = NEW.id
       AND es_principal = TRUE
       AND deleted_at IS NULL;

    -- Si el nuevo local existe (no NULL), upsertear como principal
    IF NEW.local_id IS NOT NULL THEN
      INSERT INTO rrhh_empleado_locales (
        tenant_id, empleado_id, local_id, es_principal, tipo, fecha_desde
      ) VALUES (
        NEW.tenant_id, NEW.id, NEW.local_id, TRUE, 'asignado', CURRENT_DATE
      )
      ON CONFLICT (empleado_id, local_id) DO UPDATE SET
        es_principal = TRUE,
        deleted_at = NULL,
        updated_at = NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_empleado_sync_locales_update ON rrhh_empleados;
CREATE TRIGGER trg_empleado_sync_locales_update
  AFTER UPDATE OF local_id ON rrhh_empleados
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_empleado_sync_locales_update();

-- ─── Verificación del backfill ────────────────────────────────────────────
DO $$
DECLARE
  v_huerfanos INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_huerfanos
    FROM rrhh_empleados e
   WHERE e.local_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM rrhh_empleado_locales rel
       WHERE rel.empleado_id = e.id
         AND rel.deleted_at IS NULL
     );
  IF v_huerfanos > 0 THEN
    RAISE NOTICE 'AVISO: % empleados quedaron sin relación en rrhh_empleado_locales (probable local_id apunta a local borrado).', v_huerfanos;
  ELSE
    RAISE NOTICE 'OK: todos los empleados con local_id NOT NULL tienen relación.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
