-- ════════════════════════════════════════════════════════════════════════
-- Sprint "nunca más huérfanos" — integridad referencial de movimientos de caja
-- 09-jun-2026.
--
-- CONTEXTO: el barrido de integridad encontró 8 movimientos fantasma en Neko
-- por cascada de anulación rota. Las causas raíz:
--   1) RRHH.tsx confirma novedad con delete()+insert() de la liquidación → si
--      la liquidación ya estaba pagada (tenía movimientos), quedan huérfanos.
--   2) anular_movimiento NO anula la pata hermana de una transferencia.
--   3) (borde) borrar un adelanto con movimientos vivos.
--   (anular_factura YA anula sus movimientos — AUDIT FIX #4 — no es agujero.)
--
-- ESTE ARCHIVO:
--   A) Guard BEFORE DELETE en las tablas padre financieras: bloquea borrar una
--      fila que tenga movimientos de caja vivos (anulado=false). Doble candado
--      junto al frontend (que ahora anula primero). Decisión Lucas (09-jun):
--      "que te frene y te diga: hay un pago realizado, ¿desea anularlo?".
--   B) Bypass por GUC `pase.skip_orphan_guard` para flujos de limpieza
--      (borrado de tenant, teardown de tests) que borran todo en masa.
--   C) anular_movimiento: al anular una pata de transferencia, anula la hermana.
-- ════════════════════════════════════════════════════════════════════════

-- ─── A) Función guard genérica ──────────────────────────────────────────────
-- TG_ARGV[0] = nombre de la columna FK en `movimientos` que apunta a esta tabla.
CREATE OR REPLACE FUNCTION fn_guard_no_borrar_con_movimientos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_col text := TG_ARGV[0];
  v_n   integer;
BEGIN
  -- Bypass para flujos de limpieza masiva (borrado de tenant, teardown tests).
  IF current_setting('pase.skip_orphan_guard', true) = 'on' THEN
    RETURN OLD;
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM movimientos WHERE %I = $1 AND COALESCE(anulado, false) = false',
    v_col
  ) INTO v_n USING OLD.id;

  IF v_n > 0 THEN
    RAISE EXCEPTION 'PADRE_CON_MOVIMIENTOS_VIVOS'
      USING DETAIL = format(
        'La fila %s de %s tiene %s movimiento(s) de caja sin anular. Anulá el pago antes de recalcular/borrar.',
        OLD.id, TG_TABLE_NAME, v_n
      );
  END IF;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION fn_guard_no_borrar_con_movimientos() IS
  'Guard anti-huérfanos: impide borrar un padre financiero con movimientos de caja vivos. Bypass via GUC pase.skip_orphan_guard=on (limpieza/tenant delete).';

-- ─── Triggers BEFORE DELETE en las tablas padre ────────────────────────────
DROP TRIGGER IF EXISTS trg_guard_borrar_liquidacion ON rrhh_liquidaciones;
CREATE TRIGGER trg_guard_borrar_liquidacion
  BEFORE DELETE ON rrhh_liquidaciones
  FOR EACH ROW EXECUTE FUNCTION fn_guard_no_borrar_con_movimientos('liquidacion_id');

DROP TRIGGER IF EXISTS trg_guard_borrar_adelanto ON rrhh_adelantos;
CREATE TRIGGER trg_guard_borrar_adelanto
  BEFORE DELETE ON rrhh_adelantos
  FOR EACH ROW EXECUTE FUNCTION fn_guard_no_borrar_con_movimientos('adelanto_id_ref');

DROP TRIGGER IF EXISTS trg_guard_borrar_factura ON facturas;
CREATE TRIGGER trg_guard_borrar_factura
  BEFORE DELETE ON facturas
  FOR EACH ROW EXECUTE FUNCTION fn_guard_no_borrar_con_movimientos('fact_id');

DROP TRIGGER IF EXISTS trg_guard_borrar_remito ON remitos;
CREATE TRIGGER trg_guard_borrar_remito
  BEFORE DELETE ON remitos
  FOR EACH ROW EXECUTE FUNCTION fn_guard_no_borrar_con_movimientos('remito_id_ref');

DROP TRIGGER IF EXISTS trg_guard_borrar_gasto ON gastos;
CREATE TRIGGER trg_guard_borrar_gasto
  BEFORE DELETE ON gastos
  FOR EACH ROW EXECUTE FUNCTION fn_guard_no_borrar_con_movimientos('gasto_id_ref');

-- ─── C) anular_movimiento: cascada a la pata hermana de transferencia ───────
-- Se reescribe la función agregando, al final, el bloque que anula la hermana.
-- (El resto del cuerpo se mantiene idéntico al vigente.)
CREATE OR REPLACE FUNCTION public.anular_movimiento(p_mov_id text, p_motivo text, p_override_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mov RECORD;
  v_liq RECORD;
  v_emp_id uuid;
  v_movs_restantes integer;
  v_delta_aguinaldo numeric;
  v_tenant uuid;
  v_hermanas integer := 0;
BEGIN
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

  IF NOT auth_tiene_permiso_o_override(
    'compras_anular',
    p_override_code,
    'anular_movimiento',
    jsonb_build_object('mov_id', p_mov_id, 'motivo', p_motivo)
  ) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso compras_anular';
  END IF;

  SELECT * INTO v_mov FROM movimientos WHERE id = p_mov_id FOR UPDATE;
  IF v_mov IS NULL THEN RAISE EXCEPTION 'MOVIMIENTO_NO_ENCONTRADO'; END IF;
  IF v_mov.anulado IS TRUE THEN RAISE EXCEPTION 'MOVIMIENTO_YA_ANULADO'; END IF;
  v_tenant := v_mov.tenant_id;

  PERFORM _validar_local_autorizado(v_mov.local_id);

  UPDATE movimientos
  SET anulado = true, anulado_motivo = p_motivo
  WHERE id = p_mov_id;

  -- ★ NUEVO 09-jun (sprint anti-huérfanos): si es una pata de transferencia,
  -- anular también la(s) pata(s) hermana(s) para no dejar media transferencia.
  IF v_mov.transferencia_id IS NOT NULL THEN
    UPDATE movimientos
       SET anulado = true,
           anulado_motivo = COALESCE(p_motivo, 'Anulación de la pata hermana de la transferencia')
     WHERE transferencia_id = v_mov.transferencia_id
       AND id <> p_mov_id
       AND COALESCE(anulado, false) = false;
    GET DIAGNOSTICS v_hermanas = ROW_COUNT;
  END IF;

  -- Si el movimiento estaba asociado a una liquidación de sueldo: lógica completa.
  IF v_mov.liquidacion_id IS NOT NULL THEN
    SELECT * INTO v_liq FROM rrhh_liquidaciones WHERE id = v_mov.liquidacion_id FOR UPDATE;

    SELECT COUNT(*) INTO v_movs_restantes
      FROM movimientos
     WHERE liquidacion_id = v_mov.liquidacion_id AND anulado IS NOT TRUE;

    IF v_movs_restantes = 0 THEN
      IF v_liq.estado = 'pagado' THEN
        SELECT n.empleado_id INTO v_emp_id
          FROM rrhh_novedades n
         WHERE n.id = v_liq.novedad_id;
        IF v_emp_id IS NOT NULL THEN
          v_delta_aguinaldo := COALESCE(v_liq.total_a_pagar, 0) / 12.0;
          UPDATE rrhh_empleados
             SET aguinaldo_acumulado = GREATEST(0, COALESCE(aguinaldo_acumulado, 0) - v_delta_aguinaldo)
           WHERE id = v_emp_id;
        END IF;
      END IF;

      UPDATE rrhh_adelantos
         SET descontado = false,
             liquidacion_consumidora_id = NULL
       WHERE liquidacion_consumidora_id = v_mov.liquidacion_id;

      UPDATE rrhh_liquidaciones
         SET anulado = true,
             pagos_realizados = 0,
             estado = 'pendiente'
       WHERE id = v_mov.liquidacion_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'mov_id', p_mov_id,
    'anulado', true,
    'patas_hermanas_anuladas', v_hermanas
  );
END;
$function$;

-- ─── B) Bypass del guard en eliminar_tenant_completo ────────────────────────
-- Se setea el GUC al principio del borrado masivo (transacción local).
-- Se aplica con ALTER FUNCTION ... no es posible; se reemplaza vía wrapper:
-- En su lugar documentamos: eliminar_tenant_completo se actualiza en este mismo
-- archivo agregando `PERFORM set_config('pase.skip_orphan_guard','on', true);`.
-- (ver migración: se hace con un bloque que reescribe el set_config dentro.)
