-- ============================================================
-- 202607072300_trg_soltar_reservas_al_borrar_mesa.sql
-- CANDADO: al borrar (soft-delete) o eliminar una mesa, sus reservas NO deben
-- quedar "flotando" apuntando a una mesa que ya no existe (bug 07-jul: reservas
-- colgadas de banquetas borradas trababan la barra con "MESA_OCUPADA" y quedaban
-- invisibles). Ahora, al borrar una mesa:
--   - se le saca esa mesa a toda reserva futura activa que la tenía,
--   - si le quedan otras mesas reales asignadas, se conservan,
--   - si no le queda ninguna, la reserva queda SIN ASIGNAR (mesa_id/mesas_ids NULL)
--     → visible en el listado del día para reubicarla a mano.
-- Solo toca reservas futuras/en curso (fecha_hora >= ahora - 3h) del MISMO local.
-- ============================================================

BEGIN;

-- Suelta una mesa de las reservas que la tenían (por mesa_id o dentro de mesas_ids).
CREATE OR REPLACE FUNCTION public.fn_soltar_reservas_de_mesa(p_mesa_id bigint, p_local_id integer)
RETURNS void LANGUAGE sql AS $function$
  UPDATE reservas r SET
    mesas_ids = NULLIF(array_remove(COALESCE(r.mesas_ids, ARRAY[]::bigint[]), p_mesa_id), ARRAY[]::bigint[]),
    mesa_id = CASE
      WHEN r.mesa_id = p_mesa_id
        THEN (array_remove(COALESCE(r.mesas_ids, ARRAY[]::bigint[]), p_mesa_id))[1]  -- 1ra restante o NULL
      ELSE r.mesa_id
    END,
    updated_at = now()
  WHERE r.local_id = p_local_id
    AND r.deleted_at IS NULL
    AND r.estado IN ('pendiente','confirmada','sentada')
    AND r.fecha_hora >= now() - interval '3 hours'
    AND (r.mesa_id = p_mesa_id OR p_mesa_id = ANY(COALESCE(r.mesas_ids, ARRAY[]::bigint[])));
$function$;

-- Trigger: dispara al soft-delete (deleted_at NULL -> no NULL) o al DELETE físico.
CREATE OR REPLACE FUNCTION public.trg_mesa_soltar_reservas()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM fn_soltar_reservas_de_mesa(OLD.id, OLD.local_id);
    RETURN OLD;
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    PERFORM fn_soltar_reservas_de_mesa(NEW.id, NEW.local_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mesa_soltar_reservas ON public.mesas;
CREATE TRIGGER trg_mesa_soltar_reservas
  AFTER UPDATE OR DELETE ON public.mesas
  FOR EACH ROW EXECUTE FUNCTION public.trg_mesa_soltar_reservas();

COMMIT;
