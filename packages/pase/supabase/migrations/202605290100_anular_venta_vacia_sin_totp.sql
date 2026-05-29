-- ═══════════════════════════════════════════════════════════════════════════
-- Fix UX 28-may noche: permitir anular venta vacía sin TOTP
--
-- Bug reportado por Lucas: una mesa abierta hace 13 días con $0 y sin items
-- no se podía anular desde la UI porque fn_anular_venta_comanda exige
-- manager_id con TOTP override. Camilo era el único manager TOTP del local 2,
-- y si no estaba disponible, la mesa quedaba huérfana.
--
-- Regla nueva: si la venta NO tiene dinero (total=0) y NO tiene items
-- activos, cualquier usuario authenticated puede anularla. El TOTP sigue
-- siendo OBLIGATORIO para anular ventas con plata cobrada (auditoría
-- financiera intacta).
--
-- Aditivo: cambia la lógica del check de manager_id, mantiene la firma y
-- el resto del flujo idéntico (idempotency, IDOR check, UPDATE mesa estado).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_anular_venta_comanda(
  p_venta_id BIGINT, p_manager_id UUID, p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_mesa_id BIGINT;
  v_cajero UUID;
  v_existing BIGINT;
  v_items_activos INTEGER;
  v_es_vacia BOOLEAN;
BEGIN
  -- Idempotency: si ya hay override con este key, salir.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Cargar datos de la venta primero (necesarios para decidir si TOTP aplica).
  SELECT local_id, total, mesa_id, cajero_id
    INTO v_local_id, v_total, v_mesa_id, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- Contar items NO anulados de la venta.
  SELECT COUNT(*) INTO v_items_activos
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id
     AND deleted_at IS NULL
     AND estado != 'anulado';

  -- "Vacía" = total 0 + sin items activos. No hay dinero ni consumo.
  v_es_vacia := (COALESCE(v_total, 0) = 0 AND v_items_activos = 0);

  -- Si NO es vacía, exigir manager TOTP (regla original — auditoría financiera).
  IF NOT v_es_vacia THEN
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
    ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;
  -- Si ES vacía, no validamos manager — cualquier user autenticado puede anular.

  UPDATE ventas_pos SET estado = 'anulada', anulada_at = NOW(), updated_at = NOW()
   WHERE id = p_venta_id;
  UPDATE ventas_pos_items SET estado = 'anulado', anulado_at = NOW(), updated_at = NOW()
   WHERE venta_id = p_venta_id AND estado != 'anulado';
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Audit: registrar el override. Si fue una anulación de venta vacía sin
  -- manager, manager_id = NULL en el row (queda como "anulada por cajero
  -- sin override por venta vacía"). El motivo describe el caso.
  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id,
    COALESCE(v_cajero, p_manager_id),
    p_manager_id,  -- puede ser NULL si fue venta vacía
    'void',
    CASE WHEN v_es_vacia AND p_manager_id IS NULL
         THEN COALESCE(p_motivo, '') || ' [anulación venta vacía sin TOTP]'
         ELSE p_motivo END,
    COALESCE(v_total, 0),
    p_idempotency_key
  );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_anular_venta_comanda(BIGINT, UUID, TEXT, TEXT) TO authenticated;

-- ─── Permitir manager_id NULL en ventas_pos_overrides si es void de venta vacía ─
-- Hoy la columna probablemente es NOT NULL. Necesitamos NULLable para los casos
-- donde no hubo TOTP (venta vacía).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='ventas_pos_overrides' AND column_name='manager_id' AND is_nullable='NO'
  ) THEN
    ALTER TABLE ventas_pos_overrides ALTER COLUMN manager_id DROP NOT NULL;
  END IF;
END$$;

NOTIFY pgrst, 'reload schema';
