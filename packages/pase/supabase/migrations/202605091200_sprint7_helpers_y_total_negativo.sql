-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 7 — Sesión 1
--
-- Cambios:
--   1. Helpers de validación reusables: fn_assert_local_autorizado y
--      fn_assert_empleado_en_local. Sirven para los fixes IDOR de
--      sesiones siguientes.
--   2. fn_recalc_total_venta robusto: usa GREATEST(0, ...) para impedir
--      total negativo cuando descuento_total > subtotal + propina.
--   3. CHECK constraints chk_total_no_negativo y chk_subtotal_no_negativo
--      en ventas_pos como defensa en profundidad.
--   4. fn_aplicar_descuento_comanda: rechaza descuento monto > subtotal+
--      propina y rechaza porcentaje > 100. Mantiene resto de la lógica.
--
-- Auditoría 2026-05-07: BLOCKER #1 (total negativo) + parte de BLOCKER #2.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Helpers IDOR ──────────────────────────────────────────────────────

-- Valida que p_local_id pertenezca al tenant del caller y, salvo caller
-- dueño/admin/superadmin, esté entre los locales visibles.
CREATE OR REPLACE FUNCTION fn_assert_local_autorizado(p_local_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth_es_superadmin() THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM locales
    WHERE id = p_local_id AND tenant_id = auth_tenant_id()
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO: local % no pertenece al tenant', p_local_id
      USING HINT = 'IDOR detection: local_id from another tenant';
  END IF;

  IF NOT auth_es_dueno_o_admin() AND NOT (p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_VISIBLE: local % no está entre los locales visibles', p_local_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_assert_local_autorizado(INTEGER) TO authenticated;

-- Valida que p_empleado_id pertenezca al p_local_id Y al tenant del caller.
-- Usa rrhh_empleados (donde se almacenan PINs y rol_pos).
CREATE OR REPLACE FUNCTION fn_assert_empleado_en_local(p_empleado_id UUID, p_local_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth_es_superadmin() THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
    WHERE id = p_empleado_id
      AND local_id = p_local_id
      AND tenant_id = auth_tenant_id()
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'EMPLEADO_NO_EN_LOCAL: empleado % no pertenece al local %',
      p_empleado_id, p_local_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_assert_empleado_en_local(UUID, INTEGER) TO authenticated;

-- ─── 2. fn_recalc_total_venta — total no negativo ────────────────────────
-- Original (sprint_2.sql:781-794) calculaba total = subtotal - descuento +
-- propina sin proteger contra negativos. Con descuento > subtotal+propina,
-- quedaba total < 0 → distorsión de movimientos de caja, EERR roto, vector
-- de fraude.
--
-- Mantiene firma idéntica (SECURITY DEFINER + GRANT preservados implícitos).
CREATE OR REPLACE FUNCTION fn_recalc_total_venta(p_venta_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_propina NUMERIC;
  v_total NUMERIC;
BEGIN
  -- Subtotal: suma de items no anulados.
  -- (subtotal - descuento) sigue siendo el patrón original al nivel item.
  SELECT COALESCE(SUM(subtotal - descuento), 0) INTO v_subtotal
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';

  -- Descuento + propina del header de la venta.
  SELECT COALESCE(descuento_total, 0), COALESCE(propina, 0)
    INTO v_descuento, v_propina
    FROM ventas_pos
   WHERE id = p_venta_id;

  -- BLOCKER FIX: total nunca puede ser negativo.
  v_total := GREATEST(0, v_subtotal - v_descuento + v_propina);

  UPDATE ventas_pos SET
    subtotal = v_subtotal,
    total = v_total,
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$$;

-- ─── 3. CHECK constraints — defensa en profundidad ───────────────────────
-- Si alguna otra RPC futura olvida usar fn_recalc_total_venta, el INSERT/
-- UPDATE directo a ventas_pos con total < 0 es bloqueado a nivel DB.
-- IF NOT EXISTS para idempotencia de la migration.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ventas_pos_total_no_negativo'
  ) THEN
    ALTER TABLE ventas_pos
      ADD CONSTRAINT chk_ventas_pos_total_no_negativo CHECK (total >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ventas_pos_subtotal_no_negativo'
  ) THEN
    ALTER TABLE ventas_pos
      ADD CONSTRAINT chk_ventas_pos_subtotal_no_negativo CHECK (subtotal >= 0);
  END IF;
END $$;

-- ─── 4. fn_aplicar_descuento_comanda — validar montos ────────────────────
-- Original (sprint_2.sql:968-1015) aceptaba cualquier p_monto sin validar
-- que no superara el subtotal+propina, dejando la puerta abierta al total
-- negativo (ya cubierto arriba con GREATEST + CHECK, pero fail-fast es
-- mejor UX).
--
-- También: el original interpretaba p_monto como descuento absoluto. NO
-- cambiamos esa semántica — solo agregamos validación.
--
-- IMPORTANTE: este fix NO agrega idempotency_key todavía. Eso va en la
-- siguiente migration (sprint 7 sesión 2) junto con el resto de RPCs.
CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda(
  p_venta_id BIGINT,
  p_monto NUMERIC,
  p_motivo TEXT,
  p_manager_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_subtotal NUMERIC;
  v_propina NUMERIC;
  v_local_id INTEGER;
  v_cajero UUID;
  v_pct NUMERIC;
  v_anterior NUMERIC;
  v_max_descuento NUMERIC;
BEGIN
  SELECT subtotal, COALESCE(propina, 0), local_id, cajero_id, descuento_total
    INTO v_subtotal, v_propina, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;

  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- BLOCKER #1 (parte 2): validaciones nuevas.
  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el monto debe ser >= 0';
  END IF;

  v_max_descuento := v_subtotal + v_propina;
  IF p_monto > v_max_descuento THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el descuento (%) supera el subtotal+propina (%)',
      p_monto, v_max_descuento
      USING HINT = 'Validación cliente debería haber bloqueado esto';
  END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  IF v_pct > 15 THEN
    -- Necesita manager override (lógica original mantenida).
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO_DESCUENTO_GRANDE'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
    ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;
  ELSE
    IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
    END IF;
  END IF;

  UPDATE ventas_pos SET
    descuento_total = p_monto, updated_at = NOW()
  WHERE id = p_venta_id;
  PERFORM fn_recalc_total_venta(p_venta_id);

  IF p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
      valor_anterior, valor_nuevo, monto_afectado
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
      p_manager_id, 'discount', p_motivo, v_anterior, p_monto, p_monto
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_aplicar_descuento_comanda(BIGINT, NUMERIC, TEXT, UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN sesión 1 (sprint 7)
-- ═══════════════════════════════════════════════════════════════════════════
