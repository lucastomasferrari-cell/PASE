-- =============================================================================
-- AUDIT F2 — Seguridad multi-tenant: 26 críticos auto-fixeables (DB-side)
-- Generada 2026-05-27 a partir de docs/audit-2026-05/02-seguridad-multi-tenant.md
-- =============================================================================
-- Cubre los grupos A (RLS data leak), B (RPCs sin auth), C (REVOKE helpers),
-- D (UNIQUE + tenant escape).
-- Los críticos del grupo E (endpoints serverless) y F (auth) se aplican
-- en migrations / commits separados porque tocan código TS no SQL.
-- =============================================================================

BEGIN;

-- =============================================================================
-- GRUPO A: data leak cross-tenant en tablas _history (#1-4)
-- 363+116+115+1 rows de hasta 64 tenants distintos visibles a cualquier admin.
-- Fix: replicar el patrón de filter por old_data/new_data->>'tenant_id' que ya
-- usan canales_history, items_history, item_precios_canal_history.
-- =============================================================================

DROP POLICY ventas_pos_history_select ON ventas_pos_history;
CREATE POLICY ventas_pos_history_select ON ventas_pos_history
  FOR SELECT TO authenticated USING (
    auth_es_superadmin() OR
    COALESCE(
      (old_data->>'tenant_id')::uuid,
      (new_data->>'tenant_id')::uuid
    ) = auth_tenant_id()
  );

DROP POLICY mesas_history_select ON mesas_history;
CREATE POLICY mesas_history_select ON mesas_history
  FOR SELECT TO authenticated USING (
    auth_es_superadmin() OR
    COALESCE(
      (old_data->>'tenant_id')::uuid,
      (new_data->>'tenant_id')::uuid
    ) = auth_tenant_id()
  );

DROP POLICY ventas_pos_items_history_select ON ventas_pos_items_history;
CREATE POLICY ventas_pos_items_history_select ON ventas_pos_items_history
  FOR SELECT TO authenticated USING (
    auth_es_superadmin() OR
    COALESCE(
      (old_data->>'tenant_id')::uuid,
      (new_data->>'tenant_id')::uuid
    ) = auth_tenant_id()
  );

DROP POLICY turnos_caja_history_select ON turnos_caja_history;
CREATE POLICY turnos_caja_history_select ON turnos_caja_history
  FOR SELECT TO authenticated USING (
    auth_es_superadmin() OR
    COALESCE(
      (old_data->>'tenant_id')::uuid,
      (new_data->>'tenant_id')::uuid
    ) = auth_tenant_id()
  );

-- =============================================================================
-- GRUPO D-19: comanda_permisos_catalogo sin RLS habilitado
-- 15 rows del catálogo de slugs de permisos COMANDA, cualquier authenticated
-- podía TRUNCAR/UPDATE y romper toda autorización.
-- =============================================================================

ALTER TABLE comanda_permisos_catalogo ENABLE ROW LEVEL SECURITY;

CREATE POLICY cpc_select_all ON comanda_permisos_catalogo
  FOR SELECT TO authenticated USING (true);

CREATE POLICY cpc_write_superadmin ON comanda_permisos_catalogo
  FOR ALL TO authenticated
  USING (auth_es_superadmin())
  WITH CHECK (auth_es_superadmin());

-- =============================================================================
-- GRUPO D-20: comanda_print_agents UPDATE WITH CHECK=NULL → tenant escape
-- Dueño Tenant A podía UPDATE SET tenant_id='B-uuid' y mover printer a B.
-- Hoy solo Neko tiene printers (31 rows, 1 tenant) → latente. Fix.
-- =============================================================================

ALTER POLICY print_agents_update ON comanda_print_agents
  WITH CHECK (
    (tenant_id = auth_tenant_id()) AND
    (auth_es_dueno_o_admin() OR (local_id = ANY (auth_locales_visibles())))
  );

-- También parchamos print_agents_select con WITH CHECK simétrico:
-- innecesario para SELECT (Postgres lo ignora) pero documenta intención.

-- =============================================================================
-- GRUPO D-21: usuarios.email UNIQUE global → bloqueo cross-tenant + enumeration
-- Antes: tenant A registra "admin" → tenant B no puede usar "admin".
-- Después: UNIQUE (email, tenant_id) tratando superadmins (tenant_id NULL)
-- como un único namespace especial.
-- Verificado: 0 colisiones de email cross-tenant en data actual.
-- =============================================================================

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_email_key;
DROP INDEX IF EXISTS usuarios_email_key;

-- Único por (email, tenant_id). El COALESCE en index expression trata
-- a los superadmins (tenant_id NULL) como un namespace virtual para que
-- "admin" sin tenant_id no choque con "admin" del tenant Neko.
CREATE UNIQUE INDEX usuarios_email_tenant_unique
  ON usuarios (email, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON INDEX usuarios_email_tenant_unique IS
  'Email único POR tenant. Superadmins (tenant_id NULL) comparten namespace virtual nil-uuid.';

-- =============================================================================
-- GRUPO D-22: comanda_local_settings.slug UNIQUE global → bloqueo cross-tenant
-- Verificado: 0 colisiones de slug en data actual.
-- =============================================================================

ALTER TABLE comanda_local_settings DROP CONSTRAINT IF EXISTS comanda_local_settings_slug_key;
DROP INDEX IF EXISTS comanda_local_settings_slug_key;

CREATE UNIQUE INDEX comanda_local_settings_slug_tenant_unique
  ON comanda_local_settings (slug, tenant_id);

COMMENT ON INDEX comanda_local_settings_slug_tenant_unique IS
  'Slug único POR tenant. El URL público /comanda/{slug} no colisiona cross-tenant.';

-- =============================================================================
-- GRUPO C: REVOKE de helpers internos que tenían GRANT a anon/authenticated
-- (#15-18 + extra del análisis F2B)
-- Verificado: las funciones llamadas por triggers son SECURITY DEFINER owned
-- por postgres → REVOKE de authenticated no rompe los triggers.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.agent_update_ticket(uuid, text, jsonb, text, integer, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_auto_fix_workflow(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._resync_liquidacion_pagos(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._resync_pago_especial(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_user_quiere_notif(integer, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- GRUPO B: RPCs Comanda sin auth check explícito (#5-14)
-- Agregar PERFORM fn_assert_local_autorizado(v_local_id) después del SELECT
-- inicial. La función:
--   - Si superadmin → pasa
--   - Si local pertenece al tenant del caller y está visible → pasa
--   - Caso contrario → RAISE 'LOCAL_NO_AUTORIZADO'
-- =============================================================================

-- ----- #5: fn_agregar_pago_venta_comanda -----
CREATE OR REPLACE FUNCTION public.fn_agregar_pago_venta_comanda(p_venta_id bigint, p_metodo text, p_monto numeric, p_idempotency_key text, p_cobrado_por uuid DEFAULT NULL::uuid, p_vuelto numeric DEFAULT NULL::numeric, p_propina_incluida numeric DEFAULT 0, p_cuotas integer DEFAULT NULL::integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_venta ventas_pos%ROWTYPE;
  v_pago_id BIGINT;
  v_total_pagado NUMERIC;
  v_local_id INTEGER;
  v_turno_id BIGINT;
  v_cuotas_efectivo INTEGER;
BEGIN
  SELECT id INTO v_pago_id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key;
  IF v_pago_id IS NOT NULL THEN RETURN v_pago_id; END IF;

  SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
  IF v_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- AUDIT F2B #5: defense-in-depth contra cross-tenant.
  -- Sin esto, cualquier authenticated podía pagar ventas de otro tenant
  -- iterando p_venta_id (BIGSERIAL global enumerable).
  PERFORM fn_assert_local_autorizado(v_venta.local_id);

  IF v_venta.estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_venta.estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_total_pagado
    FROM ventas_pos_pagos
   WHERE venta_id = p_venta_id AND estado = 'confirmado';

  IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN
    RAISE EXCEPTION 'SOBREPAGO: cobrarías % cuando faltan %',
      p_monto, GREATEST(0, v_venta.total - v_total_pagado);
  END IF;

  v_cuotas_efectivo := CASE
    WHEN p_cuotas IS NULL THEN NULL
    WHEN lower(p_metodo) LIKE '%credit%' THEN p_cuotas
    WHEN lower(p_metodo) LIKE '%tc%' THEN p_cuotas
    ELSE NULL
  END;

  INSERT INTO ventas_pos_pagos (
    tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
    cobrado_por, vuelto, propina_incluida, cuotas, estado, confirmado_at
  ) VALUES (
    v_venta.tenant_id, v_venta.local_id, p_venta_id, p_metodo, p_monto, p_idempotency_key,
    COALESCE(p_cobrado_por, v_venta.cajero_id), p_vuelto, COALESCE(p_propina_incluida, 0),
    v_cuotas_efectivo,
    'confirmado', NOW()
  ) RETURNING id INTO v_pago_id;

  IF v_total_pagado + p_monto >= v_venta.total - 0.01 THEN
    UPDATE ventas_pos SET
      estado = 'cobrada',
      cobrada_at = NOW(),
      updated_at = NOW()
    WHERE id = p_venta_id;

    IF v_venta.mesa_id IS NOT NULL THEN
      UPDATE mesas SET estado = 'libre' WHERE id = v_venta.mesa_id;
    END IF;
  END IF;

  v_local_id := v_venta.local_id;
  v_turno_id := v_venta.turno_caja_id;
  IF v_turno_id IS NOT NULL THEN
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id, tipo,
      monto, metodo, motivo, venta_id, idempotency_key
    ) VALUES (
      v_venta.tenant_id, v_local_id, v_turno_id,
      COALESCE(p_cobrado_por, (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
      'venta', p_monto, p_metodo,
      'Cobro venta #' || p_venta_id, p_venta_id,
      'mov_' || p_idempotency_key
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_pago_id;
END;
$function$;

-- ----- #6: fn_procesar_reversos_pendientes_comanda -----
CREATE OR REPLACE FUNCTION public.fn_procesar_reversos_pendientes_comanda(p_turno_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_local_id INTEGER;
  v_tenant_id UUID;
  v_estado TEXT;
  v_reverso RECORD;
  v_count INTEGER := 0;
BEGIN
  SELECT local_id, tenant_id, estado INTO v_local_id, v_tenant_id, v_estado
    FROM turnos_caja WHERE id = p_turno_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'TURNO_NO_ENCONTRADO'; END IF;

  -- AUDIT F2B #6: defense-in-depth contra cross-tenant.
  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado != 'abierto' THEN RAISE EXCEPTION 'TURNO_NO_ABIERTO'; END IF;

  FOR v_reverso IN
    SELECT id, pago_id, venta_id, empleado_id, metodo, monto, motivo, idempotency_key
    FROM reversos_pendientes
    WHERE local_id = v_local_id
      AND processed_at IS NULL
  LOOP
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id,
      tipo, monto, metodo, motivo, venta_id,
      idempotency_key
    ) VALUES (
      v_tenant_id, v_local_id, p_turno_id,
      v_reverso.empleado_id,
      'venta_anulada',
      -ABS(v_reverso.monto),
      v_reverso.metodo,
      v_reverso.motivo,
      v_reverso.venta_id,
      v_reverso.idempotency_key
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE reversos_pendientes
       SET processed_at = NOW(), processed_turno_id = p_turno_id
     WHERE id = v_reverso.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ----- #7: fn_aplicar_cupon -----
CREATE OR REPLACE FUNCTION public.fn_aplicar_cupon(p_cupon_id bigint, p_venta_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_venta RECORD;
  v_resultado RECORD;
  v_descuento NUMERIC;
  v_local_slug TEXT;
  v_cupon_tenant uuid;
BEGIN
  SELECT * INTO v_venta FROM ventas_pos
   WHERE id = p_venta_id AND deleted_at IS NULL FOR UPDATE;
  IF v_venta.id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  -- AUDIT F2B #7a: defense-in-depth — venta del tenant del caller.
  PERFORM fn_assert_local_autorizado(v_venta.local_id);

  -- AUDIT F2B #7b: cupón también debe pertenecer al mismo tenant que la venta.
  SELECT tenant_id INTO v_cupon_tenant FROM cupones WHERE id = p_cupon_id;
  IF v_cupon_tenant IS NULL THEN RAISE EXCEPTION 'CUPON_NO_ENCONTRADO'; END IF;
  IF v_cupon_tenant IS DISTINCT FROM v_venta.tenant_id THEN
    RAISE EXCEPTION 'CUPON_CROSS_TENANT';
  END IF;

  SELECT slug INTO v_local_slug FROM comanda_local_settings
   WHERE local_id = v_venta.local_id;
  IF v_local_slug IS NULL THEN RAISE EXCEPTION 'LOCAL_SIN_SLUG'; END IF;

  SELECT * INTO v_resultado FROM fn_validar_cupon(
    v_local_slug,
    (SELECT code FROM cupones WHERE id = p_cupon_id),
    v_venta.total,
    v_venta.cliente_telefono
  );
  IF NOT v_resultado.valido THEN RAISE EXCEPTION '%', v_resultado.motivo; END IF;

  v_descuento := v_resultado.descuento;

  UPDATE ventas_pos SET
    descuento_total = COALESCE(descuento_total, 0) + v_descuento,
    total = GREATEST(0, total - v_descuento),
    updated_at = NOW()
  WHERE id = p_venta_id;

  INSERT INTO cupon_usos (cupon_id, venta_id, cliente_id, cliente_telefono, descuento_aplicado)
  VALUES (p_cupon_id, p_venta_id, v_venta.cliente_id, v_venta.cliente_telefono, v_descuento);

  UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE id = p_cupon_id;

  RETURN v_descuento;
END;
$function$;

-- ----- #8: fn_aplicar_stock_venta -----
CREATE OR REPLACE FUNCTION public.fn_aplicar_stock_venta(p_venta_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_item RECORD;
  v_insumo RECORD;
  v_cantidad_consumida NUMERIC(12, 4);
  v_movs INTEGER := 0;
BEGIN
  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM ventas_pos WHERE id = p_venta_id AND deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;

  -- AUDIT F2B #8: defense-in-depth cross-tenant.
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

    FOR v_insumo IN
      SELECT
        ri.insumo_id,
        ri.cantidad AS cantidad_por_receta,
        ri.merma_pct,
        r.rendimiento,
        i.costo_actual
      FROM recetas r
      INNER JOIN receta_insumos ri ON ri.receta_id = r.id AND ri.deleted_at IS NULL
      INNER JOIN insumos i ON i.id = ri.insumo_id
      WHERE r.item_id = v_item.catalog_item_id
        AND r.tenant_id = v_tenant_id
        AND r.activa = TRUE
        AND r.deleted_at IS NULL
        AND (r.local_id IS NULL OR r.local_id = v_local_id)
      ORDER BY r.local_id NULLS LAST
      LIMIT 100
    LOOP
      v_cantidad_consumida := (v_insumo.cantidad_por_receta / GREATEST(v_insumo.rendimiento, 1))
                              * (1 + COALESCE(v_insumo.merma_pct, 0) / 100)
                              * v_item.cantidad;

      INSERT INTO insumo_movimientos (
        tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
        motivo, fuente_tipo, fuente_id
      ) VALUES (
        v_tenant_id, v_local_id, v_insumo.insumo_id, 'salida_venta',
        -v_cantidad_consumida, v_insumo.costo_actual,
        'Auto-decrement venta #' || p_venta_id,
        'venta_pos_item', v_item.item_id
      );
      v_movs := v_movs + 1;
    END LOOP;
  END LOOP;

  RETURN v_movs;
END;
$function$;

-- ----- #8 (b): fn_revertir_stock_venta -----
CREATE OR REPLACE FUNCTION public.fn_revertir_stock_venta(p_venta_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_count INTEGER := 0;
  v_local_id INTEGER;
BEGIN
  -- AUDIT F2B #8: defense-in-depth cross-tenant.
  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  )
  SELECT
    im.tenant_id, im.local_id, im.insumo_id, 'entrada_devolucion',
    -im.cantidad,
    im.costo_unitario,
    'Reverso anulación venta #' || p_venta_id,
    'venta_pos_item_revert', im.fuente_id
  FROM insumo_movimientos im
  INNER JOIN ventas_pos_items vpi ON vpi.id = im.fuente_id
  WHERE vpi.venta_id = p_venta_id
    AND vpi.deleted_at IS NULL
    AND im.tipo = 'salida_venta'
    AND im.fuente_tipo = 'venta_pos_item'
    AND im.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM insumo_movimientos im2
       WHERE im2.fuente_tipo = 'venta_pos_item_revert'
         AND im2.fuente_id = im.fuente_id
         AND im2.deleted_at IS NULL
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ----- #9: fn_marcar_listo_comanda -----
CREATE OR REPLACE FUNCTION public.fn_marcar_listo_comanda(p_venta_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
BEGIN
  -- AUDIT F2B #9: defense-in-depth cross-tenant.
  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos SET estado = 'lista', updated_at = NOW()
   WHERE id = p_venta_id AND estado IN ('enviada', 'abierta');
  UPDATE ventas_pos_items SET estado = 'listo', listo_at = NOW()
   WHERE venta_id = p_venta_id AND estado = 'enviado';
END;
$function$;

-- ----- #9 (b): fn_marcar_entregado_comanda -----
CREATE OR REPLACE FUNCTION public.fn_marcar_entregado_comanda(p_venta_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
BEGIN
  -- AUDIT F2B #9: defense-in-depth cross-tenant.
  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  UPDATE ventas_pos SET estado = 'entregada', updated_at = NOW()
   WHERE id = p_venta_id AND estado IN ('lista', 'enviada');
  UPDATE ventas_pos_items SET estado = 'entregado'
   WHERE venta_id = p_venta_id AND estado IN ('listo','enviado');
END;
$function$;

-- ----- #11: fn_set_pedido_geo -----
CREATE OR REPLACE FUNCTION public.fn_set_pedido_geo(p_venta_id bigint, p_lat numeric, p_lon numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_estado TEXT;
  v_local_id INTEGER;
BEGIN
  IF p_lat IS NULL OR p_lon IS NULL THEN RAISE EXCEPTION 'LATLON_NULL'; END IF;
  IF p_lat < -90 OR p_lat > 90 THEN RAISE EXCEPTION 'LAT_INVALIDA'; END IF;
  IF p_lon < -180 OR p_lon > 180 THEN RAISE EXCEPTION 'LON_INVALIDA'; END IF;

  SELECT estado, local_id INTO v_estado, v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_estado IS NULL THEN RAISE EXCEPTION 'VENTA_NO_EXISTE'; END IF;

  -- AUDIT F2B #11: defense-in-depth cross-tenant.
  -- (caller del marketplace público: ya validó token; este es defense-in-depth)
  PERFORM fn_assert_local_autorizado(v_local_id);

  IF v_estado != 'necesita_aprobacion' THEN
    RETURN;
  END IF;

  UPDATE ventas_pos
     SET cliente_lat = p_lat,
         cliente_lon = p_lon,
         updated_at = NOW()
   WHERE id = p_venta_id AND estado = 'necesita_aprobacion';
END;
$function$;

-- ----- #12: fn_recalc_costo_insumo -----
CREATE OR REPLACE FUNCTION public.fn_recalc_costo_insumo(p_insumo_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_costo_promedio NUMERIC;
  v_tenant_id UUID;
BEGIN
  -- AUDIT F2B #12: defense-in-depth cross-tenant.
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  IF NOT auth_es_superadmin() AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  SELECT AVG(
    precio_actual / NULLIF(factor_conversion * (1 - merma_pct / 100.0), 0)
  )
  INTO v_costo_promedio
  FROM materias_primas
  WHERE insumo_id = p_insumo_id
    AND activa = TRUE
    AND deleted_at IS NULL
    AND precio_actual IS NOT NULL
    AND precio_actual > 0;

  IF v_costo_promedio IS NOT NULL THEN
    UPDATE insumos
      SET costo_actual = ROUND(v_costo_promedio::numeric, 2),
          costo_actualizado_at = NOW(),
          updated_at = NOW()
      WHERE id = p_insumo_id;
  END IF;
END;
$function$;

-- ----- #12 (b): fn_recalcular_stock_insumo -----
CREATE OR REPLACE FUNCTION public.fn_recalcular_stock_insumo(p_insumo_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total NUMERIC(12, 4);
  v_tenant_id UUID;
BEGIN
  -- AUDIT F2B #12: defense-in-depth cross-tenant.
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  IF NOT auth_es_superadmin() AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  SELECT COALESCE(SUM(cantidad), 0) INTO v_total
    FROM insumo_movimientos
   WHERE insumo_id = p_insumo_id AND deleted_at IS NULL;

  UPDATE insumos SET stock_actual = v_total, updated_at = NOW()
   WHERE id = p_insumo_id;

  RETURN v_total;
END;
$function$;

-- ----- #13: fn_recalcular_totales_venta_comanda -----
CREATE OR REPLACE FUNCTION public.fn_recalcular_totales_venta_comanda(p_venta_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_subtotal NUMERIC;
  v_local_id INTEGER;
BEGIN
  -- AUDIT F2B #13: defense-in-depth cross-tenant.
  SELECT local_id INTO v_local_id FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  PERFORM fn_assert_local_autorizado(v_local_id);

  SELECT COALESCE(SUM(subtotal - descuento), 0) INTO v_subtotal
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';
  UPDATE ventas_pos SET
    subtotal = v_subtotal,
    total = v_subtotal - descuento_total + propina,
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$function$;

-- ----- #14: fn_recalcular_saldo_proveedor -----
CREATE OR REPLACE FUNCTION public.fn_recalcular_saldo_proveedor(p_proveedor_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_saldo NUMERIC;
  v_tenant_id UUID;
BEGIN
  IF p_proveedor_id IS NULL THEN RETURN; END IF;

  -- AUDIT F2B #14: defense-in-depth cross-tenant.
  SELECT tenant_id INTO v_tenant_id FROM proveedores WHERE id = p_proveedor_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;
  IF NOT auth_es_superadmin() AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'PROVEEDOR_CROSS_TENANT';
  END IF;

  SELECT
    COALESCE((
      SELECT SUM(CASE
        WHEN f.tipo = 'nota_credito' THEN -ABS(COALESCE(f.total, 0))
        ELSE GREATEST(0, COALESCE(f.total, 0) - COALESCE((
          SELECT SUM((p->>'monto')::numeric)
          FROM jsonb_array_elements(COALESCE(f.pagos, '[]'::jsonb)) p
        ), 0))
      END)
      FROM facturas f
      WHERE f.prov_id = p_proveedor_id
        AND f.estado NOT IN ('anulada', 'pagada')
    ), 0)
    +
    COALESCE((
      SELECT SUM(COALESCE(r.monto, 0))
      FROM remitos r
      WHERE r.prov_id = p_proveedor_id
        AND r.estado = 'sin_factura'
        AND r.factura_id IS NULL
    ), 0)
  INTO v_saldo;

  UPDATE proveedores SET saldo = v_saldo WHERE id = p_proveedor_id;
END;
$function$;

-- =============================================================================
-- SMOKE CHECKS — fallan si algo se rompió.
-- =============================================================================

DO $$
DECLARE
  v_n integer;
BEGIN
  -- Grupo A: las 4 history tables deben tener nueva policy
  SELECT COUNT(*) INTO v_n
  FROM pg_policies
  WHERE tablename IN ('ventas_pos_history','mesas_history','ventas_pos_items_history','turnos_caja_history')
    AND qual LIKE '%tenant_id%';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'SMOKE FAIL grupo A: 4 history tables debe tener policy con tenant filter (got %)', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK grupo A: 4 history tables con filtro tenant';

  -- Grupo D-19: comanda_permisos_catalogo con RLS
  SELECT relrowsecurity::int INTO v_n FROM pg_class WHERE relname='comanda_permisos_catalogo';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL #19: comanda_permisos_catalogo RLS no habilitado';
  END IF;
  RAISE NOTICE 'SMOKE OK #19: comanda_permisos_catalogo RLS habilitado';

  -- Grupo D-20: comanda_print_agents UPDATE con WITH CHECK
  SELECT COUNT(*) INTO v_n
  FROM pg_policies
  WHERE tablename='comanda_print_agents' AND policyname='print_agents_update'
    AND with_check IS NOT NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL #20: print_agents_update sin WITH CHECK';
  END IF;
  RAISE NOTICE 'SMOKE OK #20: print_agents_update con WITH CHECK';

  -- Grupo D-21: usuarios_email_tenant_unique presente
  SELECT COUNT(*) INTO v_n FROM pg_indexes
  WHERE tablename='usuarios' AND indexname='usuarios_email_tenant_unique';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL #21: usuarios_email_tenant_unique no existe';
  END IF;
  RAISE NOTICE 'SMOKE OK #21: usuarios email UNIQUE incluye tenant';

  -- Grupo D-22: slug tenant unique
  SELECT COUNT(*) INTO v_n FROM pg_indexes
  WHERE tablename='comanda_local_settings' AND indexname='comanda_local_settings_slug_tenant_unique';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL #22: comanda_local_settings_slug_tenant_unique no existe';
  END IF;
  RAISE NOTICE 'SMOKE OK #22: comanda slug UNIQUE incluye tenant';

  -- Grupo C: las 5 funciones deben tener REVOKE de authenticated
  SELECT COUNT(*) INTO v_n
  FROM information_schema.routine_privileges
  WHERE routine_name IN ('agent_update_ticket','dispatch_auto_fix_workflow','_resync_liquidacion_pagos','_resync_pago_especial','fn_user_quiere_notif')
    AND grantee = 'authenticated';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL grupo C: % funciones todavía tienen GRANT a authenticated', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK grupo C: helpers REVOKEd de authenticated/anon';
END $$;

COMMIT;
