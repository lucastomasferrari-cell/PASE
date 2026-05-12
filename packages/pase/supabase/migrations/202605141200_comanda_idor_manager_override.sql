-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA — BLOCKER IDOR en manager override
--
-- Cierra el último BLOCKER pendiente de AUDITORIA_TECNICA_2026-05-07 #1.1
-- ("manager puede ser de otro local — análisis aparte" del blockers_fix
-- 2026-05-11).
--
-- Contexto:
--   `fn_anular_item_comanda` y `fn_aplicar_descuento_comanda` aceptan
--   `p_manager_id` como override de autorización. El audit original detectó
--   que la versión sprint_2 NO validaba que `p_manager_id` fuera del mismo
--   tenant que el caller — un cajero del tenant A podía pasar el UUID de
--   un manager del tenant B y la auditoría quedaba con un override "firmado"
--   por alguien que nunca autorizó.
--
--   Sprint 7 (202605091210) intentó arreglarlo llamando
--   `fn_assert_empleado_en_local(p_manager_id, v_local_id)` — pero ese
--   helper exige que el manager esté asignado al MISMO local que la venta.
--   Eso rompe el caso de uso real: un dueño/admin (sin local específico)
--   o un manager regional autorizando en cualquiera de las sucursales del
--   tenant. Lucas tiene 5 locales — un manager visitando otra sucursal
--   debería poder autorizar.
--
-- Fix:
--   1. Nuevo helper `fn_assert_manager_override_comanda(p_manager_id)`:
--      valida solo que el manager sea (a) del mismo tenant, (b) con
--      rol_pos manager/dueno, (c) pos_activo=true. NO valida local —
--      el override es cross-local por diseño.
--   2. Helper adicional `fn_assert_local_autorizado(v_local_id)` (ya existe
--      del sprint7) para validar que el caller VEA el local de la venta —
--      previene IDOR en `p_item_id`/`p_venta_id` (un cajero del local A no
--      puede tocar items/ventas del local B aunque sea mismo tenant, salvo
--      dueño/admin que tienen visión total intra-tenant).
--   3. Re-aplica las dos RPCs (`fn_anular_item_comanda`,
--      `fn_aplicar_descuento_comanda`) con el patrón correcto. Mantiene
--      idempotency, validaciones de monto y demás lógica del sprint7.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 0. DROP overloads viejos sin idempotency_key ──────────────────────
-- Sprint 2 creó versiones SIN p_idempotency_key. Sprint 7 agregó versiones
-- CON p_idempotency_key pero NO dropeó las viejas — quedaron como overloads
-- callable que NO tienen el IDOR fix. Las eliminamos acá.

DROP FUNCTION IF EXISTS fn_anular_item_comanda(BIGINT, UUID, TEXT);
DROP FUNCTION IF EXISTS fn_aplicar_descuento_comanda(BIGINT, NUMERIC, TEXT, UUID);

-- ─── 1. Helper: validar manager override (intra-tenant, cross-local) ─────

CREATE OR REPLACE FUNCTION fn_assert_manager_override_comanda(p_manager_id UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_manager_id IS NULL THEN
    RAISE EXCEPTION 'MANAGER_REQUERIDO';
  END IF;
  IF auth_es_superadmin() THEN
    -- Aún así validar que exista y sea manager/dueno (defense vs UUID inventado).
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id
         AND rol_pos IN ('manager','dueno')
         AND pos_activo = TRUE
    ) THEN
      RAISE EXCEPTION 'MANAGER_INVALIDO';
    END IF;
    RETURN;
  END IF;
  -- Para no-superadmin: manager debe ser del mismo tenant + activo + manager/dueno.
  -- NO validar local — el override es cross-local intencional (un dueño
  -- visitando una sucursal de su tenant, o un manager regional, puede
  -- autorizar en cualquier punto del tenant).
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_manager_id
       AND tenant_id = auth_tenant_id()
       AND rol_pos IN ('manager','dueno')
       AND pos_activo = TRUE
  ) THEN
    RAISE EXCEPTION 'MANAGER_INVALIDO';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_assert_manager_override_comanda(UUID) TO authenticated;

-- ─── 2. fn_anular_item_comanda — IDOR fix correcto ──────────────────────

CREATE OR REPLACE FUNCTION fn_anular_item_comanda(
  p_item_id BIGINT,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_subtotal NUMERIC;
  v_cajero UUID;
  v_existing BIGINT;
BEGIN
  -- IDEMPOTENCY: si ya hay override con este key, salir (efecto ya aplicado).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
     WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Fetch item + local (necesario para autorizaciones siguientes).
  SELECT venta_id, local_id, subtotal INTO v_venta_id, v_local_id, v_subtotal
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  -- IDOR FIX A: el local de la venta debe ser visible al caller.
  -- Previene que un cajero del local A toque un item del local B aunque
  -- sea mismo tenant. Dueño/admin bypasean el check de visibilidad pero
  -- el helper aún chequea que el local exista en el tenant del caller.
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- IDOR FIX B: el manager debe ser del mismo tenant + activo (override
  -- cross-local permitido — ver fn_assert_manager_override_comanda).
  PERFORM fn_assert_manager_override_comanda(p_manager_id);

  SELECT cajero_id INTO v_cajero FROM ventas_pos WHERE id = v_venta_id;

  UPDATE ventas_pos_items SET
    estado = 'anulado', anulado_at = NOW(),
    anulado_motivo = p_motivo, updated_at = NOW()
  WHERE id = p_item_id;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, venta_item_id,
    cajero_id, manager_id, accion, motivo, monto_afectado, idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, v_venta_id, p_item_id,
    COALESCE(v_cajero, p_manager_id), p_manager_id, 'void', p_motivo, v_subtotal,
    p_idempotency_key
  );

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;

GRANT EXECUTE ON FUNCTION fn_anular_item_comanda(BIGINT, UUID, TEXT, TEXT) TO authenticated;

-- ─── 3. fn_aplicar_descuento_comanda — IDOR fix correcto ─────────────────

CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda(
  p_venta_id BIGINT,
  p_monto NUMERIC,
  p_motivo TEXT,
  p_manager_id UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_subtotal NUMERIC;
  v_propina NUMERIC;
  v_local_id INTEGER;
  v_cajero UUID;
  v_pct NUMERIC;
  v_anterior NUMERIC;
  v_max_descuento NUMERIC;
  v_existing BIGINT;
BEGIN
  -- IDEMPOTENCY check vs override registrado con este key.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
     WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT subtotal, COALESCE(propina, 0), local_id, cajero_id, descuento_total
    INTO v_subtotal, v_propina, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- IDOR FIX A: el local de la venta debe ser visible al caller (previene
  -- cajero local A → venta local B).
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- Validaciones de monto (sprint7).
  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el monto debe ser >= 0';
  END IF;
  v_max_descuento := v_subtotal + v_propina;
  IF p_monto > v_max_descuento THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el descuento (%) supera el subtotal+propina (%)',
      p_monto, v_max_descuento;
  END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  IF v_pct > 15 THEN
    -- IDOR FIX B: manager intra-tenant (cross-local OK), activo.
    PERFORM fn_assert_manager_override_comanda(p_manager_id);
  ELSE
    IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
    END IF;
    -- Si igualmente vino un manager (no requerido pero permitido para auditoría),
    -- validarlo intra-tenant también — evita registrar override con manager_id
    -- de otro tenant.
    IF p_manager_id IS NOT NULL THEN
      PERFORM fn_assert_manager_override_comanda(p_manager_id);
    END IF;
  END IF;

  UPDATE ventas_pos SET
    descuento_total = p_monto, updated_at = NOW()
  WHERE id = p_venta_id;
  PERFORM fn_recalc_total_venta(p_venta_id);

  IF p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
      valor_anterior, valor_nuevo, monto_afectado, idempotency_key
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
      p_manager_id, 'discount', p_motivo, v_anterior, p_monto, p_monto,
      p_idempotency_key
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_aplicar_descuento_comanda(BIGINT, NUMERIC, TEXT, UUID, TEXT) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación (consultas que el aplicador debería correr post-migration):
--   SELECT proname, pronargs FROM pg_proc WHERE proname IN
--     ('fn_assert_manager_override_comanda', 'fn_anular_item_comanda', 'fn_aplicar_descuento_comanda');
--   -- Esperado: las 3 funciones presentes.
-- ═══════════════════════════════════════════════════════════════════════════
