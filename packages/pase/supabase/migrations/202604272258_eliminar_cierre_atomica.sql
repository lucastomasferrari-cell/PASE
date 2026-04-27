-- ═══════════════════════════════════════════════════════════════════════════
-- Ventas: RPC eliminar_cierre — wrapper atómico para borrar TODAS las
-- ventas de un cierre (mismo local + fecha + turno) en una sola transacción.
--
-- Antes existía solo eliminar_venta(id) y el frontend (Ventas.tsx
-- eliminarBloque) loopeaba secuencialmente. Si la 3ª de 5 ventas fallaba,
-- las 2 primeras quedaban borradas y el resto no — estado parcial sin
-- rollback. Esta RPC corre toda la operación dentro del cuerpo de una
-- función plpgsql, así que cualquier RAISE EXCEPTION revierte todo.
--
-- Backwards compat: las ventas de cierres legacy (pre-4bccd8b) tienen
-- movimientos sin venta_ids — la lógica los detecta, borra solo la venta
-- y marca contiene_legacy=true en el output. El frontend muestra un alert
-- pidiéndole a Lucas que borre el mov huérfano a mano (no podemos
-- matchearlo heurísticamente sin riesgo de falsos positivos).
--
-- La lógica de ajuste de movimientos se inlinea (no llama eliminar_venta
-- por venta) para que la auditoría sea una sola por cierre y para evitar
-- N audits ELIMINAR_VENTA + 1 ELIMINAR_CIERRE redundantes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.eliminar_cierre(
  p_local_id int,
  p_fecha date,
  p_turno text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_mov RECORD;
  v_saldo_delta numeric;
  v_ventas_borradas int := 0;
  v_movs_borrados int := 0;
  v_movs_actualizados int := 0;
  v_contiene_legacy boolean := false;
  v_venta_ids_borrados text[] := ARRAY[]::text[];
  v_total_borrado numeric := 0;
BEGIN
  IF p_local_id IS NULL OR p_fecha IS NULL OR p_turno IS NULL OR length(p_turno) = 0 THEN
    RAISE EXCEPTION 'PARAMETROS_REQUERIDOS';
  END IF;

  -- Auth upfront — todas las ventas del cierre comparten local_id.
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  -- Loop sobre todas las ventas del cierre. FOR UPDATE evita que otra
  -- transacción modifique las ventas mientras estamos procesándolas.
  FOR v_venta IN
    SELECT * FROM ventas
    WHERE local_id = p_local_id AND fecha = p_fecha AND turno = p_turno
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Buscar el movimiento linkeado a esta venta (mismo lookup que
    -- eliminar_venta).
    SELECT * INTO v_mov FROM movimientos
    WHERE venta_ids @> ARRAY[v_venta.id]::text[]
    LIMIT 1;

    IF v_mov.id IS NOT NULL THEN
      IF array_length(v_mov.venta_ids, 1) = 1 THEN
        -- Esta venta es la única del mov → borrar mov + restar saldo full.
        DELETE FROM movimientos WHERE id = v_mov.id;
        v_saldo_delta := v_mov.importe;
        v_movs_borrados := v_movs_borrados + 1;
      ELSE
        -- El mov tiene otras ventas → restar solo el monto de esta.
        UPDATE movimientos
        SET importe = importe - v_venta.monto,
            venta_ids = array_remove(venta_ids, v_venta.id)
        WHERE id = v_mov.id;
        v_saldo_delta := v_venta.monto;
        v_movs_actualizados := v_movs_actualizados + 1;
      END IF;

      IF v_mov.local_id IS NOT NULL THEN
        UPDATE saldos_caja
        SET saldo = saldo - v_saldo_delta
        WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
      END IF;
    ELSE
      -- Sin mov linkeado → cierre legacy (pre-4bccd8b) o medio sin
      -- impacto en caja. Si hay un mov huérfano por fecha/local/cuenta
      -- correspondiente, hay que borrarlo manualmente — no podemos
      -- matchear sin riesgo de falsos positivos.
      v_contiene_legacy := true;
    END IF;

    DELETE FROM ventas WHERE id = v_venta.id;
    v_ventas_borradas := v_ventas_borradas + 1;
    v_venta_ids_borrados := array_append(v_venta_ids_borrados, v_venta.id);
    v_total_borrado := v_total_borrado + v_venta.monto;
  END LOOP;

  IF v_ventas_borradas = 0 THEN
    RAISE EXCEPTION 'CIERRE_NO_ENCONTRADO';
  END IF;

  -- Auditoría top-level: una sola entrada con el resumen del cierre.
  PERFORM _auditar('ventas', 'ELIMINAR_CIERRE', jsonb_build_object(
    'local_id', p_local_id,
    'fecha', p_fecha,
    'turno', p_turno,
    'ventas_borradas', v_ventas_borradas,
    'venta_ids', v_venta_ids_borrados,
    'monto_total_borrado', v_total_borrado,
    'movimientos_borrados', v_movs_borrados,
    'movimientos_actualizados', v_movs_actualizados,
    'contiene_legacy', v_contiene_legacy,
    'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object(
    'ventas_borradas', v_ventas_borradas,
    'movimientos_borrados', v_movs_borrados,
    'movimientos_actualizados', v_movs_actualizados,
    'contiene_legacy', v_contiene_legacy,
    'monto_total_borrado', v_total_borrado
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.eliminar_cierre(int, date, text) TO authenticated;
