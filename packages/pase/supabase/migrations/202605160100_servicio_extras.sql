-- ─── Servicio extras: tiempo prep + coursing auto + open tab ────────────────
-- 3 features para que el POS cubra el flow de servicio real:
--
-- 1. items.tiempo_prep_min — minutos estimados de preparación, opcional.
--    Sirve para que el mozo le diga al cliente "tarda ~15min" + para
--    calcular tiempo total estimado de la mesa.
--
-- 2. ventas_pos.coursing_auto — si TRUE, cuando todos los items del curso N
--    están en estado='listo', el sistema dispara automáticamente el curso N+1
--    (todos los items hold de ese curso pasan a enviada). El handler vive en
--    el client (KDS marcarListo wrapper) para no tocar las RPCs core.
--
-- 3. ventas_pos.tab_nombre — etiqueta libre para "open tab" tipo barra
--    ("Juan barba", "Mesa 3 cumple"). Cuando está seteado, la venta es una
--    tab y aparece destacada en la lista de mostrador.

ALTER TABLE items ADD COLUMN IF NOT EXISTS tiempo_prep_min INTEGER NULL;
COMMENT ON COLUMN items.tiempo_prep_min IS 'Minutos estimados de preparación. NULL = sin estimación. Para mostrar al cajero/mozo el tiempo esperado de la mesa.';

ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS coursing_auto BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN ventas_pos.coursing_auto IS 'Si TRUE, al marcar listo el último item de un curso, KDS dispara automático el siguiente curso pendiente.';

ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS tab_nombre TEXT NULL;
COMMENT ON COLUMN ventas_pos.tab_nombre IS 'Etiqueta para open tab tipo barra. NULL = venta normal. Cuando seteado, la venta aparece destacada en mostrador.';

CREATE INDEX IF NOT EXISTS idx_ventas_pos_tab
  ON ventas_pos(local_id) WHERE tab_nombre IS NOT NULL AND deleted_at IS NULL;

-- ─── Trigger coursing automático ─────────────────────────────────────────────
-- Cuando un item pasa a 'listo', si la venta tiene coursing_auto=TRUE y
-- todos los items del MISMO curso ya están listos/entregados/anulados,
-- automáticamente envía el siguiente curso (todos los items en hold del
-- curso N+1 pasan a 'enviada' con enviada_at=NOW).
--
-- Idempotente: si ya no hay items hold en el N+1, no hace nada.

CREATE OR REPLACE FUNCTION fn_coursing_auto_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta_id INTEGER;
  v_curso_actual INTEGER;
  v_coursing_auto BOOLEAN;
  v_quedan_en_curso INTEGER;
  v_siguiente_curso INTEGER;
  v_disparados INTEGER;
BEGIN
  -- Solo nos importa cuando un item pasa de !listo a listo
  IF NEW.estado != 'listo' THEN RETURN NEW; END IF;
  IF OLD.estado = 'listo' THEN RETURN NEW; END IF;

  v_venta_id := NEW.venta_id;
  v_curso_actual := COALESCE(NEW.curso, 1);

  -- Verificar si la venta tiene coursing_auto activado
  SELECT coursing_auto INTO v_coursing_auto FROM ventas_pos WHERE id = v_venta_id;
  IF v_coursing_auto IS NOT TRUE THEN RETURN NEW; END IF;

  -- Contar items del MISMO curso que NO están listos/entregados/anulados
  SELECT COUNT(*) INTO v_quedan_en_curso
    FROM ventas_pos_items
   WHERE venta_id = v_venta_id
     AND COALESCE(curso, 1) = v_curso_actual
     AND estado NOT IN ('listo', 'entregado', 'anulado')
     AND id != NEW.id;  -- el item que estamos marcando

  IF v_quedan_en_curso > 0 THEN
    RETURN NEW;  -- todavía quedan en este curso
  END IF;

  -- Buscar el siguiente curso con items en hold
  SELECT MIN(COALESCE(curso, 1)) INTO v_siguiente_curso
    FROM ventas_pos_items
   WHERE venta_id = v_venta_id
     AND COALESCE(curso, 1) > v_curso_actual
     AND estado = 'hold';

  IF v_siguiente_curso IS NULL THEN
    RETURN NEW;  -- no hay curso siguiente con items hold
  END IF;

  -- Disparar el curso siguiente (pasar de 'hold' a 'enviado').
  -- IMPORTANTE: estado item es MASCULINO ('enviado'), columna enviado_at
  -- también masculino (≠ ventas_pos.enviada_at que es femenino).
  UPDATE ventas_pos_items
     SET estado = 'enviado',
         enviado_at = NOW(),
         updated_at = NOW()
   WHERE venta_id = v_venta_id
     AND COALESCE(curso, 1) = v_siguiente_curso
     AND estado = 'hold';
  GET DIAGNOSTICS v_disparados = ROW_COUNT;

  IF v_disparados > 0 THEN
    RAISE NOTICE 'Coursing auto: venta=% curso N=% completo, disparado curso %=% items',
      v_venta_id, v_curso_actual, v_siguiente_curso, v_disparados;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_coursing_auto ON ventas_pos_items;
CREATE TRIGGER trg_coursing_auto
  AFTER UPDATE OF estado ON ventas_pos_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_coursing_auto_check();

COMMENT ON FUNCTION fn_coursing_auto_check IS
  'Trigger automático: si venta tiene coursing_auto=TRUE y se completa un curso, dispara el siguiente. Idempotente.';

NOTIFY pgrst, 'reload schema';
