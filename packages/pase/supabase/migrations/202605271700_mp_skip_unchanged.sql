-- =============================================================================
-- F3A#11: mp_movimientos skip UPDATEs que no cambian data
-- =============================================================================
-- Antes: mp-process.js hacía .upsert() en cada sync (cada 30 min). El upsert
-- INSERT...ON CONFLICT genera UPDATE incluso si los valores son idénticos
-- → 150k UPDATEs sobre 5k filas, 80% inútiles. Esto:
--   - infla WAL (cada UPDATE escribe nueva versión de la fila)
--   - dispara triggers AFTER UPDATE innecesarios
--   - consume xact_id
--
-- Fix server-side: trigger BEFORE UPDATE que retorna NULL (= skip) cuando
-- OLD = NEW. No hay que cambiar mp-process.js — el upsert sigue igual.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_skip_unchanged_mp_mov() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- F3A#11: comparar todo el row excluyendo columnas auto-management que
  -- siempre cambian aunque la data real no (si hubiera updated_at, etc.).
  -- mp_movimientos no tiene updated_at columna trigger-managed → comparamos
  -- toda la fila con IS NOT DISTINCT FROM (handles NULLs correctamente).
  IF to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN
    RETURN NULL; -- skip this UPDATE silenciosamente
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_skip_unchanged_mp_mov ON mp_movimientos;
CREATE TRIGGER trg_skip_unchanged_mp_mov
  BEFORE UPDATE ON mp_movimientos
  FOR EACH ROW
  EXECUTE FUNCTION fn_skip_unchanged_mp_mov();

DO $smoke$
DECLARE v_n int;
BEGIN
  SELECT COUNT(*) INTO v_n FROM pg_trigger WHERE tgname='trg_skip_unchanged_mp_mov';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE FAIL: trigger no creado'; END IF;
  RAISE NOTICE 'SMOKE OK F3A#11: trigger trg_skip_unchanged_mp_mov activo';
END $smoke$;

COMMIT;
