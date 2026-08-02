-- Cajero puede anular ítem / anular venta / descuento grande SIN manager (con motivo)
-- ---------------------------------------------------------------------------
-- Pedido Anto (01-ago): sacar el PIN de manager para que el CAJERO borre ítems de
-- mesa, anule la mesa entera y aplique descuentos > umbral — pero manteniendo el
-- MOTIVO obligatorio (queda registrado quién y por qué). Editable desde Accesos.
--
-- Diseño (permiso-driven, aditivo, sin romper el camino actual):
--   * En una sesión POS el DB ve la cuenta compartida del local, no al cajero;
--     el cajero real llega como parámetro (p_manager_id = el actor). Por eso la
--     autorización individual se resuelve mirando el rol_pos del actor contra
--     rol_pos_permisos (la misma tabla que edita Accesos → Roles).
--   * Nuevo helper fn_actor_puede_override(actor, slug): TRUE si el actor es
--     manager/dueño (fallback histórico) O su rol tiene el permiso activo.
--   * Las 3 RPCs pasan a exigir ese helper + motivo no vacío, en vez de exigir
--     rol manager sí o sí. Granting el slug al cajero → lo hace él; revocándolo
--     en Accesos → vuelve a necesitar un manager. Managers/dueños intactos.

-- ── Helper de autorización de override ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_actor_puede_override(p_actor_id uuid, p_slug text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM rrhh_empleados e
     WHERE e.id = p_actor_id
       AND e.pos_activo = TRUE
       AND (
         e.rol_pos IN ('manager','dueno')            -- fallback histórico
         OR EXISTS (
           SELECT 1 FROM rol_pos_permisos rp
            WHERE rp.rol_pos = e.rol_pos
              AND rp.activo = TRUE
              AND rp.slug = p_slug
         )
       )
  );
$function$;

-- ── 1) Anular ÍTEM ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_anular_item_comanda(p_item_id bigint, p_manager_id uuid, p_motivo text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_subtotal NUMERIC;
  v_cajero UUID;
  v_existing BIGINT;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'AUTORIZACION_REQUERIDA'; END IF;
  IF COALESCE(TRIM(p_motivo), '') = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;
  IF NOT fn_actor_puede_override(p_manager_id, 'comanda.items.anular') THEN
    RAISE EXCEPTION 'SIN_AUTORIZACION';
  END IF;

  SELECT venta_id, local_id, subtotal INTO v_venta_id, v_local_id, v_subtotal
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);

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
$function$;

-- ── 2) Anular VENTA entera ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_anular_venta_comanda(p_venta_id bigint, p_manager_id uuid, p_motivo text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_mesa_id BIGINT;
  v_cajero UUID;
  v_existing BIGINT;
  v_items_activos INTEGER;
  v_es_vacia BOOLEAN;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT local_id, total, mesa_id, cajero_id
    INTO v_local_id, v_total, v_mesa_id, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  SELECT COUNT(*) INTO v_items_activos
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id
     AND deleted_at IS NULL
     AND estado != 'anulado';

  v_es_vacia := (COALESCE(v_total, 0) = 0 AND v_items_activos = 0);

  -- El caller SIEMPRE debe pertenecer al local de la venta (AUDIT 09-jun H4).
  PERFORM fn_assert_local_autorizado(v_local_id);

  -- Si NO es vacía: exigir autorización (actor con permiso O manager/dueño) + motivo.
  IF NOT v_es_vacia THEN
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'AUTORIZACION_REQUERIDA'; END IF;
    IF COALESCE(TRIM(p_motivo), '') = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;
    IF NOT fn_actor_puede_override(p_manager_id, 'comanda.ventas.anular') THEN
      RAISE EXCEPTION 'SIN_AUTORIZACION';
    END IF;
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;
  -- Si ES vacía, no validamos actor — cualquier user autenticado puede anular.

  UPDATE ventas_pos SET estado = 'anulada', anulada_at = NOW(), updated_at = NOW()
   WHERE id = p_venta_id;
  UPDATE ventas_pos_items SET estado = 'anulado', anulado_at = NOW(), updated_at = NOW()
   WHERE venta_id = p_venta_id AND estado != 'anulado';
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado,
    idempotency_key
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id,
    COALESCE(v_cajero, p_manager_id),
    p_manager_id,
    'void',
    CASE WHEN v_es_vacia AND p_manager_id IS NULL
         THEN COALESCE(p_motivo, '') || ' [anulación venta vacía sin TOTP]'
         ELSE p_motivo END,
    COALESCE(v_total, 0),
    p_idempotency_key
  );
END;
$function$;

-- ── 3) DESCUENTO grande ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_aplicar_descuento_comanda(p_venta_id bigint, p_monto numeric, p_motivo text DEFAULT NULL::text, p_manager_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_subtotal NUMERIC;
  v_propina NUMERIC;
  v_local_id INTEGER;
  v_cajero UUID;
  v_pct NUMERIC;
  v_anterior NUMERIC;
  v_max_descuento NUMERIC;
  v_existing BIGINT;
  v_req_auth BOOLEAN;
  v_pct_umbral NUMERIC;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM ventas_pos_overrides
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT subtotal, COALESCE(propina, 0), local_id, cajero_id, descuento_total
    INTO v_subtotal, v_propina, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  IF p_manager_id IS NOT NULL THEN
    PERFORM fn_assert_empleado_en_local(p_manager_id, v_local_id);
  END IF;

  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el monto debe ser >= 0';
  END IF;
  v_max_descuento := v_subtotal + v_propina;
  IF p_monto > v_max_descuento THEN
    RAISE EXCEPTION 'DESCUENTO_INVALIDO: el descuento (%) supera el subtotal+propina (%)',
      p_monto, v_max_descuento;
  END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  SELECT COALESCE(req_auth_descuento, false), COALESCE(req_auth_descuento_pct, 15)
    INTO v_req_auth, v_pct_umbral
    FROM comanda_local_settings
   WHERE local_id = v_local_id AND deleted_at IS NULL
   LIMIT 1;
  v_req_auth := COALESCE(v_req_auth, false);
  v_pct_umbral := COALESCE(v_pct_umbral, 15);

  IF v_req_auth AND v_pct > v_pct_umbral THEN
    -- Descuento GRANDE: exigir actor autorizado (permiso O manager/dueño) + motivo.
    -- Antes exigía rol manager sí o sí; ahora el cajero con permiso lo hace él.
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'AUTORIZACION_REQUERIDA_DESCUENTO_GRANDE'; END IF;
    IF COALESCE(TRIM(p_motivo), '') = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;
    IF NOT fn_actor_puede_override(p_manager_id, 'comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_AUTORIZACION';
    END IF;
  ELSE
    IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
    END IF;
  END IF;

  UPDATE ventas_pos SET
    descuento_total = p_monto,
    descuento_efectivo_pct = NULL,
    updated_at = NOW()
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
$function$;

-- ── 4) Grant al rol CAJERO (editable en Accesos → Roles) ────────────────────
-- items.anular no lo tenía nadie; se lo damos también a manager/encargado/pos_local
-- para que el botón les aparezca (ya podían anular ítems por rol). El cajero suma
-- los 3. Todo con activo=true; Accesos togglea después.
INSERT INTO rol_pos_permisos (rol_pos, slug, activo)
VALUES
  ('cajero',    'comanda.items.anular',     true),
  ('cajero',    'comanda.ventas.anular',    true),
  ('cajero',    'comanda.ventas.descuento', true),
  ('manager',   'comanda.items.anular',     true),
  ('encargado', 'comanda.items.anular',     true),
  ('pos_local', 'comanda.items.anular',     true)
ON CONFLICT (rol_pos, slug) DO UPDATE SET activo = true, updated_at = now();
