-- ═══════════════════════════════════════════════════════════════════════════
-- ALTOS + MEDIOS Auditoría 2026-05-21
--
-- - ALTO-11: anular_remito + anular_gasto con FOR UPDATE (ya en 202605212400)
-- - ALTO-13: policies service_role explícitas en tablas que les faltan
-- - MED-3: fn_registrar_merma validar que p_local_id pertenezca al tenant
-- - MED-4: fn_cancelar_traspaso solo origen puede cancelar (no destino)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── ALTO-13: policies service_role explícitas ────────────────────────────
-- service_role bypasea RLS por diseño en supabase-js. Las policies explícitas
-- son por consistencia con el patrón del repo + para que el linter de
-- Supabase no flagee tablas como "sin policies".

DO $$
BEGIN
  -- tenant_subscriptions
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'tenant_subscriptions'::regclass
      AND polname = 'tenant_subscriptions_service_all'
  ) THEN
    CREATE POLICY tenant_subscriptions_service_all ON tenant_subscriptions
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- tabla no existe, ignorar
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'tenant_invoices'::regclass
      AND polname = 'tenant_invoices_service_all'
  ) THEN
    CREATE POLICY tenant_invoices_service_all ON tenant_invoices
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'mermas_motivos'::regclass
      AND polname = 'mermas_motivos_service_all'
  ) THEN
    CREATE POLICY mermas_motivos_service_all ON mermas_motivos
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'simulaciones'::regclass
      AND polname = 'simulaciones_service_all'
  ) THEN
    CREATE POLICY simulaciones_service_all ON simulaciones
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ─── MED-3: fn_registrar_merma validar p_local_id pertenece al tenant ─────
-- Defense-in-depth: si un bug ocurre y un usuario tiene un local de otro
-- tenant en auth_locales_visibles(), evitar que registre mermas cross-tenant.
CREATE OR REPLACE FUNCTION fn_registrar_merma(
  p_insumo_id BIGINT,
  p_local_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo_id BIGINT,
  p_notas TEXT DEFAULT NULL,
  p_manager_id INTEGER DEFAULT NULL,
  p_override_code TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_motivo RECORD;
  v_insumo RECORD;
  v_mov_id BIGINT;
  v_user_id INTEGER;
  v_manager_id INTEGER := NULL;
  v_override_ok BOOLEAN;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  v_user_id := auth_usuario_id();

  -- MED-3 FIX: validar que el local pertenezca al tenant del caller.
  IF NOT EXISTS (
    SELECT 1 FROM locales
     WHERE id = p_local_id AND tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;

  SELECT * INTO v_motivo FROM mermas_motivos
    WHERE id = p_motivo_id
      AND tenant_id = v_tenant_id
      AND activo = TRUE
      AND deleted_at IS NULL;
  IF v_motivo IS NULL THEN RAISE EXCEPTION 'MOTIVO_NO_ENCONTRADO'; END IF;

  IF v_motivo.tipo_movimiento = 'robo' THEN
    v_override_ok := auth_tiene_permiso_o_override(
      'stock_anular',
      p_override_code,
      'registrar_robo_insumo',
      jsonb_build_object(
        'insumo_id', p_insumo_id,
        'local_id', p_local_id,
        'cantidad', p_cantidad,
        'motivo', v_motivo.nombre
      )
    );
    IF NOT v_override_ok THEN
      IF p_override_code IS NULL THEN
        RAISE EXCEPTION 'ROBO_REQUIERE_OVERRIDE';
      ELSE
        RAISE EXCEPTION 'OVERRIDE_INVALIDO';
      END IF;
    END IF;
    v_manager_id := NULL;
  END IF;

  SELECT * INTO v_insumo FROM insumos
    WHERE id = p_insumo_id
      AND tenant_id = v_tenant_id
      AND deleted_at IS NULL
    FOR UPDATE;
  IF v_insumo IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id, manager_id
  ) VALUES (
    v_tenant_id, p_local_id, p_insumo_id, v_motivo.tipo_movimiento,
    -p_cantidad, COALESCE(v_insumo.costo_actual, 0),
    v_motivo.nombre || COALESCE(' — ' || p_notas, ''),
    'merma_motivo', p_motivo_id,
    v_user_id, v_manager_id
  ) RETURNING id INTO v_mov_id;

  RETURN v_mov_id;
END;
$$;

-- ─── MED-4: fn_cancelar_traspaso solo origen (destino debe rechazar) ──────
-- Antes: "cualquiera de los 2 locales puede cancelar". Esto permitía al
-- receptor cancelar sin motivo obligatorio, ocultando problemas que ameritan
-- usar fn_rechazar_recepcion_traspaso (que sí pide motivo de 3+ chars).
CREATE OR REPLACE FUNCTION fn_cancelar_traspaso(
  p_transferencia_id BIGINT,
  p_motivo TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
  v_transf RECORD;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  v_user_id := auth_usuario_id();

  SELECT * INTO v_transf
    FROM stock_transferencias
   WHERE id = p_transferencia_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF v_transf IS NULL THEN RAISE EXCEPTION 'TRANSFERENCIA_NO_ENCONTRADA'; END IF;

  IF v_transf.estado <> 'en_transito' THEN
    RAISE EXCEPTION 'TRANSFERENCIA_NO_PENDIENTE';
  END IF;

  -- MED-4 FIX: solo el local ORIGEN (o dueño/admin) puede cancelar.
  -- El destino debe usar fn_rechazar_recepcion_traspaso (que requiere motivo).
  IF NOT (auth_es_dueno_o_admin()
          OR v_transf.local_origen_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_ORIGEN';
  END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id
  ) VALUES (
    v_tenant_id, v_transf.local_origen_id, v_transf.insumo_id, 'entrada_devolucion',
    v_transf.cantidad, COALESCE(v_transf.costo_unitario, 0),
    'Cancelación de traspaso' || COALESCE(': ' || p_motivo, ''),
    'transferencia', p_transferencia_id, v_user_id
  );

  UPDATE stock_transferencias SET
    estado = 'cancelada',
    fecha_confirmacion = NOW(),
    confirmado_por = v_user_id,
    cancelado_motivo = p_motivo
  WHERE id = p_transferencia_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
