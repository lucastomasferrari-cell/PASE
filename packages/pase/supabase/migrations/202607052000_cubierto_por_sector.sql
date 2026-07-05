-- 202607052000 · Cubierto por sector (fase 1)
--
-- Pedido de Lucas 2026-07-05 (ver project_comanda_pendientes_post_a2 #7).
-- En AR se cobra "cubierto" por comensal (línea obligatoria de servicio de
-- mesa). Modelamos:
--   • Precio POR SECTOR (comanda_cubiertos_config keyed por (local_id, zona)).
--     Barra puede ser $0, Salón $500, Terraza $700.
--   • Ítem visible en la comanda como cualquier otro (items.es_cubierto=true).
--     Se anula con PIN manager igual que cualquier otro ítem (comportamiento
--     heredado — no hay bypass).
--   • Auto-agrega al abrir la mesa: N × precio_cubierto en cantidad × precio_u.
--
-- Idempotente: reejecutar la migración no duplica items ni configs.

-- ─── 1. Flag en items ──────────────────────────────────────────────────────
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS es_cubierto boolean NOT NULL DEFAULT false;

-- Solo puede haber un item cubierto activo por local — reglas del negocio.
-- (deleted_at IS NULL parte del filtro para permitir reseed si un dueño hard-borra.)
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_cubierto_por_local
  ON items (local_id) WHERE es_cubierto = true AND deleted_at IS NULL;

-- ─── 2. Tabla de configuración por sector ──────────────────────────────────
CREATE TABLE IF NOT EXISTS comanda_cubiertos_config (
  id           serial       PRIMARY KEY,
  tenant_id    uuid         NOT NULL,
  local_id     integer      NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
  zona         text         NOT NULL,
  precio       numeric(12,2) NOT NULL DEFAULT 0 CHECK (precio >= 0),
  activo       boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (local_id, zona)
);

CREATE INDEX IF NOT EXISTS ix_cubiertos_config_local
  ON comanda_cubiertos_config (local_id) WHERE activo = true;

-- RLS: dueño/admin ven todo del tenant; encargado solo su(s) local(es).
ALTER TABLE comanda_cubiertos_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cubiertos_config_all ON comanda_cubiertos_config;
CREATE POLICY cubiertos_config_all ON comanda_cubiertos_config
  FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

DROP TRIGGER IF EXISTS trg_cubiertos_config_touch ON comanda_cubiertos_config;
CREATE TRIGGER trg_cubiertos_config_touch
  BEFORE UPDATE ON comanda_cubiertos_config
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 3. Helper get-or-create del item "Cubierto" del local ─────────────────
-- Cada local tiene UN item "Cubierto" (system item, invisible en catálogos).
-- El precio real vive en cubiertos_config, no en item_precios_canal.
CREATE OR REPLACE FUNCTION fn_get_or_create_cubierto_item(p_local_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_id   integer;
  v_tenant_id uuid;
BEGIN
  PERFORM fn_assert_local_autorizado(p_local_id);

  SELECT id INTO v_item_id FROM items
   WHERE local_id = p_local_id
     AND es_cubierto = true
     AND deleted_at IS NULL
   ORDER BY id LIMIT 1;
  IF v_item_id IS NOT NULL THEN
    RETURN v_item_id;
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM locales WHERE id = p_local_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  INSERT INTO items (
    tenant_id, local_id, nombre,
    es_cubierto, estado,
    visible_pos, visible_qr, visible_tienda
  ) VALUES (
    v_tenant_id, p_local_id, 'Cubierto',
    true, 'disponible',
    false, false, false
  ) RETURNING id INTO v_item_id;

  RETURN v_item_id;
END;
$$;

-- ─── 4. Helper que asegura el item cubierto en una venta ───────────────────
-- Se llama desde ambos fn_abrir_venta_comanda (online + offline).
-- Idempotente: si ya existe una línea de cubierto en la venta, actualiza
-- cantidad+precio; si no, inserta.
CREATE OR REPLACE FUNCTION fn_ensure_cubierto_en_venta(p_venta_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id     integer;
  v_mesa_id      bigint;
  v_covers       integer;
  v_tenant_id    uuid;
  v_zona         text;
  v_precio       numeric(12,2);
  v_activo       boolean;
  v_item_id      integer;
  v_existing_id  bigint;
BEGIN
  SELECT v.local_id, v.mesa_id, v.covers, v.tenant_id
    INTO v_local_id, v_mesa_id, v_covers, v_tenant_id
    FROM ventas_pos v WHERE v.id = p_venta_id;

  -- Sin mesa o sin comensales → no aplica cubierto.
  IF v_mesa_id IS NULL OR v_covers IS NULL OR v_covers < 1 THEN
    RETURN;
  END IF;

  SELECT m.zona INTO v_zona FROM mesas m WHERE m.id = v_mesa_id;
  IF v_zona IS NULL OR v_zona = '' THEN
    RETURN;
  END IF;

  SELECT c.precio, c.activo INTO v_precio, v_activo
    FROM comanda_cubiertos_config c
   WHERE c.local_id = v_local_id AND c.zona = v_zona
   LIMIT 1;

  -- No configurado / inactivo / precio 0 → no hay cubierto.
  IF v_activo IS NOT TRUE OR v_precio IS NULL OR v_precio <= 0 THEN
    RETURN;
  END IF;

  v_item_id := fn_get_or_create_cubierto_item(v_local_id);

  SELECT vi.id INTO v_existing_id
    FROM ventas_pos_items vi
   WHERE vi.venta_id = p_venta_id
     AND vi.item_id = v_item_id
     AND vi.deleted_at IS NULL
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE ventas_pos_items SET
      cantidad = v_covers,
      precio_unitario = v_precio,
      subtotal = v_covers * v_precio,
      updated_at = NOW()
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO ventas_pos_items (
      tenant_id, local_id, venta_id, item_id,
      cantidad, precio_unitario, subtotal,
      estado, curso
    ) VALUES (
      v_tenant_id, v_local_id, p_venta_id, v_item_id,
      v_covers, v_precio, v_covers * v_precio,
      'hold', 1
    );
  END IF;

  PERFORM fn_recalcular_totales_venta_comanda(p_venta_id);
END;
$$;

-- ─── 5. Wire en fn_abrir_venta_comanda (online) ────────────────────────────
-- Reemplazo completo preservando signature. Único agregado: PERFORM fn_ensure_cubierto_en_venta(v_id).
CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda(
  p_local_id integer,
  p_modo text,
  p_canal_id integer,
  p_mesa_id bigint DEFAULT NULL,
  p_mozo_id uuid DEFAULT NULL,
  p_cajero_id uuid DEFAULT NULL,
  p_cliente_nombre text DEFAULT NULL,
  p_cliente_telefono text DEFAULT NULL,
  p_cliente_direccion text DEFAULT NULL,
  p_covers integer DEFAULT NULL,
  p_origen text DEFAULT 'pos',
  p_tipo_entrega text DEFAULT NULL,
  p_estado text DEFAULT 'abierta',
  p_programada_para timestamptz DEFAULT NULL,
  p_cliente_id bigint DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id BIGINT;
  v_numero INTEGER;
  v_turno_id BIGINT;
  v_reserva_cliente BIGINT;
BEGIN
  IF p_origen = 'pos' AND NOT (
    fn_check_perm_comanda('comanda.ventas.abrir') OR
    fn_check_perm_comanda('comanda.ventas.cobrar')
  ) THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  IF v_turno_id IS NULL AND p_origen = 'pos' AND p_modo != 'pedidos' THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;

  v_numero := fn_next_ticket_number_comanda(p_local_id);

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id, turno_caja_id,
    mesa_id, mozo_id, cajero_id, cliente_id, cliente_nombre, cliente_telefono,
    cliente_direccion, covers, origen, tipo_entrega, estado, programada_para
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_modo, p_canal_id, v_turno_id,
    p_mesa_id, p_mozo_id, p_cajero_id, p_cliente_id, p_cliente_nombre, p_cliente_telefono,
    p_cliente_direccion, p_covers, p_origen, p_tipo_entrega, p_estado, p_programada_para
  ) RETURNING id INTO v_id;

  IF p_mesa_id IS NOT NULL AND p_estado = 'abierta' THEN
    UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_id AND estado = 'libre';
  END IF;

  IF p_mesa_id IS NOT NULL THEN
    UPDATE reservas r
       SET venta_id = v_id, updated_at = NOW()
     WHERE r.id = (
       SELECT r2.id FROM reservas r2
        WHERE r2.mesa_id = p_mesa_id
          AND r2.local_id = p_local_id
          AND r2.estado = 'sentada'
          AND r2.venta_id IS NULL
          AND r2.deleted_at IS NULL
          AND r2.fecha_hora BETWEEN NOW() - INTERVAL '4 hours' AND NOW() + INTERVAL '2 hours'
        ORDER BY abs(extract(epoch FROM (r2.fecha_hora - NOW()))) ASC
        LIMIT 1
     )
     RETURNING r.cliente_id INTO v_reserva_cliente;
    IF v_reserva_cliente IS NOT NULL THEN
      UPDATE ventas_pos SET cliente_id = COALESCE(cliente_id, v_reserva_cliente)
       WHERE id = v_id;
    END IF;
  END IF;

  -- Cubierto por sector (2026-07-05).
  PERFORM fn_ensure_cubierto_en_venta(v_id);

  RETURN v_id;
END;
$$;

-- ─── 6. Wire en fn_abrir_venta_comanda_offline ─────────────────────────────
CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda_offline(
  p_local_id integer,
  p_canal_id integer,
  p_modo text,
  p_mesa_id integer DEFAULT NULL,
  p_mozo_id uuid DEFAULT NULL,
  p_cajero_id uuid DEFAULT NULL,
  p_cliente_id integer DEFAULT NULL,
  p_covers integer DEFAULT NULL,
  p_tab_nombre text DEFAULT NULL,
  p_idempotency_uuid uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id BIGINT;
  v_new_id BIGINT;
  v_numero_local INTEGER;
  v_turno_id BIGINT;
BEGIN
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM ventas_pos WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  IF auth_tenant_id() IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  PERFORM fn_assert_local_autorizado(p_local_id);

  SELECT COALESCE(MAX(numero_local), 0) + 1
    INTO v_numero_local
    FROM ventas_pos
   WHERE local_id = p_local_id;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, canal_id, modo, mesa_id,
    mozo_id, cajero_id, cliente_id, covers, tab_nombre,
    turno_caja_id, estado, abierta_at, idempotency_uuid
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero_local, p_canal_id, p_modo, p_mesa_id,
    p_mozo_id, p_cajero_id, p_cliente_id, p_covers, p_tab_nombre,
    v_turno_id, 'abierta', NOW(), p_idempotency_uuid
  )
  RETURNING id INTO v_new_id;

  -- Cubierto por sector (2026-07-05).
  PERFORM fn_ensure_cubierto_en_venta(v_new_id);

  RETURN v_new_id;
END;
$$;

-- ─── 7. Seed rows en cubiertos_config para zonas existentes ────────────────
-- Precio 0 + activo=false por default: cada dueño configura después desde admin.
INSERT INTO comanda_cubiertos_config (tenant_id, local_id, zona, precio, activo)
SELECT DISTINCT l.tenant_id, m.local_id, m.zona, 0, false
  FROM mesas m
  JOIN locales l ON l.id = m.local_id
 WHERE m.zona IS NOT NULL AND m.zona <> '' AND m.deleted_at IS NULL
ON CONFLICT (local_id, zona) DO NOTHING;
