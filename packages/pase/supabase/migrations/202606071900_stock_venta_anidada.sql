-- 202606071900_stock_venta_anidada.sql
-- Pieza C — Stock · Fase 1 (venta descuenta stock anidado).
--
-- BUG: fn_aplicar_stock_venta solo descontaba las líneas de receta con insumo
-- directo (INNER JOIN insumos) e IGNORABA las sub-recetas (prep_item_id). Así,
-- vender un Roll que usa la sub-receta "Shari" NO descontaba el arroz/vinagre
-- del Shari del stock.
--
-- FIX: fn_consumir_stock_receta recursivo (mismo álgebra que fn_calcular_costo_
-- receta: cantidad/rendimiento × (1+merma) por nivel). fn_aplicar_stock_venta
-- llama al recursivo por cada item vendido. Idempotencia preservada (chequeo
-- NOT EXISTS por venta_pos_item afuera; toda la cascada se atribuye al mismo
-- venta_pos_item).

-- ── Helper recursivo: consume el stock de una receta y sus sub-recetas ──
CREATE OR REPLACE FUNCTION fn_consumir_stock_receta(
  p_receta_id      bigint,
  p_factor         numeric,   -- batches de esta receta a consumir
  p_local_id       integer,
  p_tenant_id      uuid,
  p_fuente_item_id bigint,    -- venta_pos_item al que se atribuye todo
  p_venta_id       bigint,
  p_depth          integer DEFAULT 0
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_linea     RECORD;
  v_ef        numeric;       -- cantidad efectiva consumida de esta línea
  v_prep_rec  bigint;
  v_prep_rend numeric;
  v_movs      integer := 0;
BEGIN
  IF p_depth > 10 THEN RETURN 0; END IF;  -- guarda anti-ciclo

  FOR v_linea IN
    SELECT ri.insumo_id, ri.prep_item_id, ri.cantidad, ri.merma_pct, i.costo_actual
      FROM receta_insumos ri
      LEFT JOIN insumos i ON i.id = ri.insumo_id AND i.deleted_at IS NULL
     WHERE ri.receta_id = p_receta_id AND ri.deleted_at IS NULL
  LOOP
    v_ef := COALESCE(v_linea.cantidad, 0)
            * (1 + COALESCE(v_linea.merma_pct, 0) / 100.0)
            * p_factor;

    IF v_linea.insumo_id IS NOT NULL THEN
      -- Insumo directo → movimiento de salida.
      INSERT INTO insumo_movimientos (
        tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
        motivo, fuente_tipo, fuente_id
      ) VALUES (
        p_tenant_id, p_local_id, v_linea.insumo_id, 'salida_venta',
        -v_ef, v_linea.costo_actual,
        'Auto-decrement venta #' || p_venta_id,
        'venta_pos_item', p_fuente_item_id
      );
      v_movs := v_movs + 1;

    ELSIF v_linea.prep_item_id IS NOT NULL THEN
      -- Sub-receta → resolver su receta y recursar. La sub-receta rinde
      -- v_prep_rend unidades; consumimos v_ef → batches = v_ef / rendimiento.
      SELECT r.id, GREATEST(r.rendimiento, 1)
        INTO v_prep_rec, v_prep_rend
        FROM recetas r
       WHERE r.item_id = v_linea.prep_item_id
         AND r.activa = TRUE AND r.deleted_at IS NULL
         AND (r.local_id IS NULL OR r.local_id = p_local_id)
       ORDER BY r.local_id NULLS LAST
       LIMIT 1;
      IF v_prep_rec IS NOT NULL THEN
        v_movs := v_movs + fn_consumir_stock_receta(
          v_prep_rec, v_ef / v_prep_rend, p_local_id, p_tenant_id,
          p_fuente_item_id, p_venta_id, p_depth + 1
        );
      END IF;
    END IF;
  END LOOP;

  RETURN v_movs;
END;
$$;

REVOKE ALL ON FUNCTION fn_consumir_stock_receta(bigint, numeric, integer, uuid, bigint, bigint, integer) FROM PUBLIC;

-- ── fn_aplicar_stock_venta: usa el recursivo ──
CREATE OR REPLACE FUNCTION public.fn_aplicar_stock_venta(p_venta_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_tenant_id UUID;
  v_local_id  INTEGER;
  v_item      RECORD;
  v_rec       bigint;
  v_rend      numeric;
  v_movs      INTEGER := 0;
BEGIN
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM ventas_pos WHERE id = p_venta_id AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  FOR v_item IN
    SELECT vpi.id AS item_id, vpi.item_id AS catalog_item_id, vpi.cantidad
      FROM ventas_pos_items vpi
     WHERE vpi.venta_id = p_venta_id
       AND vpi.deleted_at IS NULL
       AND vpi.estado != 'anulado'
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos im
          WHERE im.fuente_tipo = 'venta_pos_item'
            AND im.fuente_id = vpi.id
            AND im.deleted_at IS NULL
       )
  LOOP
    PERFORM pg_advisory_xact_lock(v_item.catalog_item_id);

    SELECT r.id, GREATEST(r.rendimiento, 1)
      INTO v_rec, v_rend
      FROM recetas r
     WHERE r.item_id = v_item.catalog_item_id
       AND r.tenant_id = v_tenant_id
       AND r.activa = TRUE AND r.deleted_at IS NULL
       AND (r.local_id IS NULL OR r.local_id = v_local_id)
     ORDER BY r.local_id NULLS LAST
     LIMIT 1;

    IF v_rec IS NOT NULL THEN
      v_movs := v_movs + fn_consumir_stock_receta(
        v_rec, v_item.cantidad / v_rend, v_local_id, v_tenant_id,
        v_item.item_id, p_venta_id, 0
      );
    END IF;
  END LOOP;

  RETURN v_movs;
END;
$function$;

NOTIFY pgrst, 'reload schema';
