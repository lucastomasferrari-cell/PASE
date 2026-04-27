-- ═══════════════════════════════════════════════════════════════════════════
-- Ventas: RPCs atómicas para eliminar y editar venta, manteniendo
-- consistencia con movimientos y saldos_caja.
--
-- Bug previo: db.from("ventas").delete() y .update() desde el frontend
-- borran/editan SOLO la fila de ventas — los movimientos derivados
-- (Caja Chica) y saldos_caja quedaban descuadrados. Side-effect del
-- bug histórico Maxirest del 23-24 abril (corregido en 3d19197):
-- al borrar las ventas duplicadas, el movimiento con 2x quedó
-- huérfano en BD.
--
-- Fix: agregamos columna movimientos.venta_ids text[] que linkea
-- explícitamente cada movimiento de venta con sus ventas originales.
-- Las RPCs eliminar_venta y editar_venta hacen el ajuste atómico:
-- borran/editan la venta + ajustan el movimiento + ajustan el saldo
-- + auditan, todo en una transacción.
--
-- Backwards compat: para ventas legacy cuyos movimientos no tienen
-- venta_ids match, las RPCs operan SOLO sobre la fila de ventas. Los
-- movs viejos son inmutables (ya están corregidos manualmente).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Columna venta_ids en movimientos. Index GIN para búsqueda
--    @> ARRAY[p_venta_id] eficiente. Default NULL — los movs legacy
--    sin link se quedan así.
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS venta_ids text[] DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_movimientos_venta_ids
  ON movimientos USING GIN (venta_ids)
  WHERE venta_ids IS NOT NULL;

-- 2) RPC eliminar_venta — atómico:
--    a) lee venta + valida auth (caller dueño/admin o local en visibles)
--    b) busca movimiento con venta_ids @> [p_venta_id]
--    c) si la venta es la única del mov: borra mov + resta saldo full
--       si hay otras: resta solo el monto de esta + array_remove
--    d) borra venta
--    e) audita
CREATE OR REPLACE FUNCTION public.eliminar_venta(p_venta_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_mov RECORD;
  v_saldo_delta numeric := 0;
  v_mov_borrado boolean := false;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN
    RAISE EXCEPTION 'VENTA_ID_REQUERIDO';
  END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

  -- Auth: dueño/admin pasa siempre; encargado solo si el local está
  -- en sus locales visibles.
  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  -- Buscar movimiento con esta venta linkeada.
  SELECT * INTO v_mov FROM movimientos
  WHERE venta_ids @> ARRAY[p_venta_id]::text[]
  LIMIT 1;

  IF v_mov.id IS NOT NULL THEN
    IF array_length(v_mov.venta_ids, 1) = 1 THEN
      -- Esta venta es la única del movimiento — borrar mov + restar saldo full.
      DELETE FROM movimientos WHERE id = v_mov.id;
      v_saldo_delta := v_mov.importe;
      v_mov_borrado := true;
    ELSE
      -- Hay otras ventas en el mismo movimiento — restar solo el monto de
      -- esta y sacarla del array.
      UPDATE movimientos
      SET importe = importe - v_venta.monto,
          venta_ids = array_remove(venta_ids, p_venta_id)
      WHERE id = v_mov.id;
      v_saldo_delta := v_venta.monto;
    END IF;

    -- Ajustar saldos_caja del local + cuenta. Si la fila no existe, el
    -- UPDATE no hace nada (caso edge, no abortamos).
    IF v_mov.local_id IS NOT NULL THEN
      UPDATE saldos_caja
      SET saldo = saldo - v_saldo_delta
      WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
    END IF;
  END IF;
  -- Si v_mov.id IS NULL: venta legacy sin link. Borrar SOLO la venta.

  DELETE FROM ventas WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'ELIMINAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id,
    'monto', v_venta.monto,
    'medio', v_venta.medio,
    'local_id', v_venta.local_id,
    'fecha', v_venta.fecha,
    'turno', v_venta.turno,
    'mov_id', v_mov.id,
    'mov_borrado', v_mov_borrado,
    'saldo_delta', v_saldo_delta,
    'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object(
    'venta_id', p_venta_id,
    'mov_id', v_mov.id,
    'mov_borrado', v_mov_borrado,
    'saldo_delta', v_saldo_delta
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.eliminar_venta(text) TO authenticated;

-- 3) RPC editar_venta — atómico, SOLO cambia el monto.
--    Otros campos (fecha, turno, medio, local_id) NO se editan acá
--    porque cambian la cuenta destino y requeririan un flow distinto.
--    El frontend puede hacer update directo de esos campos para casos
--    de typo, asumiendo el riesgo.
CREATE OR REPLACE FUNCTION public.editar_venta(p_venta_id text, p_nuevo_monto numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_mov RECORD;
  v_delta numeric;
BEGIN
  IF p_venta_id IS NULL OR length(p_venta_id) = 0 THEN
    RAISE EXCEPTION 'VENTA_ID_REQUERIDO';
  END IF;
  IF p_nuevo_monto IS NULL OR p_nuevo_monto <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO';
  END IF;

  SELECT * INTO v_venta FROM ventas WHERE id = p_venta_id;
  IF v_venta IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_venta.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  v_delta := p_nuevo_monto - v_venta.monto;

  IF v_delta != 0 THEN
    SELECT * INTO v_mov FROM movimientos
    WHERE venta_ids @> ARRAY[p_venta_id]::text[]
    LIMIT 1;

    IF v_mov.id IS NOT NULL THEN
      UPDATE movimientos SET importe = importe + v_delta WHERE id = v_mov.id;
      IF v_mov.local_id IS NOT NULL THEN
        UPDATE saldos_caja SET saldo = saldo + v_delta
        WHERE cuenta = v_mov.cuenta AND local_id = v_mov.local_id;
      END IF;
    END IF;
  END IF;

  UPDATE ventas SET monto = p_nuevo_monto WHERE id = p_venta_id;

  PERFORM _auditar('ventas', 'EDITAR_VENTA', jsonb_build_object(
    'venta_id', p_venta_id,
    'monto_anterior', v_venta.monto,
    'monto_nuevo', p_nuevo_monto,
    'delta', v_delta,
    'local_id', v_venta.local_id,
    'mov_id', v_mov.id,
    'usuario_id', auth_usuario_id()
  ));

  RETURN jsonb_build_object(
    'venta_id', p_venta_id,
    'monto_nuevo', p_nuevo_monto,
    'delta', v_delta,
    'mov_ajustado', v_mov.id IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.editar_venta(text, numeric) TO authenticated;
