-- ============================================================
-- 202607100200_trg_reservas_no_overbook.sql
-- Trigger DB-level que impide asignar una mesa ya ocupada, cualquiera
-- sea el camino: RPC, script, migración masiva, admin PASE viejo (Reservas.tsx),
-- INSERT directo. Estructural: NUNCA más overbookings.
--
-- Contexto: barrido 10-jul encontró 12 overbookings históricos en Maneki
-- (0 vivos) — creados por migración Woki/Tableo con INSERTs directos y por
-- casos donde el motor no detectó la ocupación. El trigger cierra todos los
-- caminos posibles.
--
-- Semántica:
--  - Aplica a INSERT y UPDATE cuando cambia mesa_id, mesas_ids, fecha_hora,
--    duracion_min o estado (pasa a estado activo).
--  - Solo si el estado post es activo ('pendiente','confirmada','sentada').
--  - Excluye la propia fila (self-check).
--  - Detecta solapamientos por [fecha_hora, fecha_hora + duracion_min).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_reservas_no_overbook()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mesas bigint[];
  v_dur   integer;
  v_conflict RECORD;
BEGIN
  -- Solo bloqueamos si el estado post-cambio es activo.
  IF NEW.estado NOT IN ('pendiente','confirmada','sentada') THEN
    RETURN NEW;
  END IF;

  -- Deleted no cuenta (soft delete).
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_mesas := COALESCE(NULLIF(NEW.mesas_ids, '{}'), ARRAY[NEW.mesa_id]);
  IF v_mesas IS NULL OR array_length(v_mesas, 1) IS NULL THEN
    -- Sin mesa asignada: no hay overbooking posible.
    RETURN NEW;
  END IF;

  v_dur := COALESCE(NEW.duracion_min, 90);

  -- Buscar cualquier reserva ACTIVA de este local que comparta alguna mesa
  -- y cuyo horario se solape con la nueva.
  SELECT r.id, r.cliente_nombre, r.fecha_hora, r.estado, r.mesa_id
    INTO v_conflict
  FROM reservas r
  WHERE r.local_id = NEW.local_id
    AND r.deleted_at IS NULL
    AND r.id <> NEW.id
    AND r.estado IN ('pendiente','confirmada','sentada')
    AND (r.mesa_id = ANY(v_mesas)
         OR EXISTS (SELECT 1 FROM unnest(COALESCE(r.mesas_ids, ARRAY[]::bigint[])) x
                    WHERE x = ANY(v_mesas)))
    AND r.fecha_hora < NEW.fecha_hora + make_interval(mins => v_dur)
    AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, 90)) > NEW.fecha_hora
  LIMIT 1;

  IF v_conflict.id IS NOT NULL THEN
    RAISE EXCEPTION 'MESA_OCUPADA_TRG: mesa ya reservada por #% (%) a las % [reserva nueva id=%]',
      v_conflict.id, v_conflict.cliente_nombre, v_conflict.fecha_hora, NEW.id;
  END IF;

  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS trg_reservas_no_overbook ON reservas;

CREATE TRIGGER trg_reservas_no_overbook
BEFORE INSERT OR UPDATE OF mesa_id, mesas_ids, fecha_hora, duracion_min, estado, deleted_at
ON reservas
FOR EACH ROW
EXECUTE FUNCTION public.trg_reservas_no_overbook();

COMMIT;
