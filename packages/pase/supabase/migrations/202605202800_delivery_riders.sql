-- ═══════════════════════════════════════════════════════════════════════════
-- Delivery Riders + GPS positions
--
-- Sistema de tracking para repartidores SIN app nativa. El rider abre una
-- URL única (https://comanda/r/{token}) en su celular, le da permiso a
-- "ubicación" y la PWA postea cada 30s al backend con su lat/lon.
--
-- Tablas:
--   - delivery_riders: el repartidor como entidad. Token único = "magic
--     link" para el celular. No requiere usuario/PIN — la fricción mata
--     adopción. El dueño puede revocar el token desde admin.
--   - rider_positions: histórico de posiciones. Append-only. Para tracking
--     en vivo + auditoría "¿dónde estaba la moto a las 21:35?".
--
-- ¿Por qué SECURITY DEFINER sin auth para fn_actualizar_posicion_rider?
-- El rider no tiene cuenta JWT. La auth es por token (32 chars random,
-- 256 bits de entropía). Si el dueño sospecha que se filtró, rota.
-- Mismo modelo que comanda_print_agents.agent_token.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_riders (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  local_id        INTEGER NOT NULL,
  rider_token     TEXT UNIQUE NOT NULL,
  nombre          TEXT NOT NULL,
  telefono        TEXT,
  foto_url        TEXT,
  activo          BOOLEAN DEFAULT TRUE,
  -- Bandera "el rider activó el toggle 'estoy online' en su celu". Distinto
  -- a `activo` que es admin-controlled.
  online          BOOLEAN DEFAULT FALSE,
  -- Última posición conocida (denormalizada para evitar joins en hot path)
  last_seen_at    TIMESTAMPTZ,
  last_lat        NUMERIC(10, 7),
  last_lon        NUMERIC(10, 7),
  last_accuracy_m NUMERIC(8, 2),
  last_battery_pct INTEGER,
  -- Pedido que está entregando ahora mismo (null = libre)
  current_venta_id BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT check_local_id CHECK (local_id > 0)
);

CREATE INDEX IF NOT EXISTS idx_riders_tenant_local
  ON delivery_riders(tenant_id, local_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_riders_token
  ON delivery_riders(rider_token) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_riders_local_online
  ON delivery_riders(local_id, online) WHERE deleted_at IS NULL;

-- ─── Histórico de posiciones (append-only) ────────────────────────────
--
-- High-write table: cada rider postea cada 30s. Con 10 riders activos =
-- 1200 rows/hora. Vamos a tener un cron que prune posiciones > 7 días.
CREATE TABLE IF NOT EXISTS rider_positions (
  id            BIGSERIAL PRIMARY KEY,
  rider_id      BIGINT NOT NULL REFERENCES delivery_riders(id) ON DELETE CASCADE,
  lat           NUMERIC(10, 7) NOT NULL,
  lon           NUMERIC(10, 7) NOT NULL,
  accuracy_m    NUMERIC(8, 2),
  speed_kmh     NUMERIC(6, 2),
  heading_deg   NUMERIC(5, 2),
  battery_pct   INTEGER,
  -- Cuando el celu capturó el fix (mejor que server time, da más precisión)
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Cuando el server recibió (útil para detectar lag/batched submits)
  server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_rider_captured
  ON rider_positions(rider_id, captured_at DESC);

-- ─── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE delivery_riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_positions ENABLE ROW LEVEL SECURITY;

-- Dueño/admin del tenant + scope por local visible
CREATE POLICY riders_all ON delivery_riders
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  );

-- Posiciones: SELECT solo dentro del scope local visible (joineado por rider).
CREATE POLICY positions_select ON rider_positions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM delivery_riders r
      WHERE r.id = rider_positions.rider_id
        AND r.tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles()))
    )
  );

-- Las inserts vienen del rider (SECURITY DEFINER), no necesitan policy
-- authenticated. Pero dejamos una para que el dueño pueda insertar manual
-- si hace falta (debug).
CREATE POLICY positions_insert ON rider_positions
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM delivery_riders r
      WHERE r.id = rider_positions.rider_id
        AND r.tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles()))
    )
  );

-- ─── Updated_at trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_riders_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS riders_updated_at ON delivery_riders;
CREATE TRIGGER riders_updated_at
  BEFORE UPDATE ON delivery_riders
  FOR EACH ROW EXECUTE FUNCTION trg_riders_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Crear un rider y devolver su token ───────────────────────────────
--
-- Para admin/encargado. El token se le pasa al rider via WhatsApp/SMS
-- (link: comanda.app/r/{token}).
CREATE OR REPLACE FUNCTION fn_crear_delivery_rider(
  p_local_id INTEGER,
  p_nombre TEXT,
  p_telefono TEXT DEFAULT NULL,
  p_foto_url TEXT DEFAULT NULL
) RETURNS TABLE (id BIGINT, rider_token TEXT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_token TEXT;
  v_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_id AND tenant_id = v_tenant_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF p_nombre IS NULL OR length(trim(p_nombre)) = 0 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO delivery_riders (tenant_id, local_id, rider_token, nombre, telefono, foto_url)
  VALUES (v_tenant_id, p_local_id, v_token, trim(p_nombre), NULLIF(trim(p_telefono),''), NULLIF(trim(p_foto_url),''))
  RETURNING delivery_riders.id INTO v_id;

  RETURN QUERY SELECT v_id, v_token;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_crear_delivery_rider(INTEGER, TEXT, TEXT, TEXT) TO authenticated;

-- ─── Update posición del rider (público — auth por token) ─────────────
--
-- Llamada desde la PWA del celu del rider. No requiere login.
-- Atómicamente:
--   1. UPSERT en rider_positions
--   2. UPDATE denormalizado en delivery_riders (last_*)
--
-- Si el token es inválido / rider revocado, devuelve error.
CREATE OR REPLACE FUNCTION fn_actualizar_posicion_rider(
  p_rider_token TEXT,
  p_lat NUMERIC,
  p_lon NUMERIC,
  p_accuracy_m NUMERIC DEFAULT NULL,
  p_speed_kmh NUMERIC DEFAULT NULL,
  p_heading_deg NUMERIC DEFAULT NULL,
  p_battery_pct INTEGER DEFAULT NULL,
  p_captured_at TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE (rider_id BIGINT, ok BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_rider_id BIGINT;
  v_now TIMESTAMPTZ := NOW();
  v_captured TIMESTAMPTZ := COALESCE(p_captured_at, v_now);
BEGIN
  IF p_rider_token IS NULL OR length(p_rider_token) < 16 THEN
    RAISE EXCEPTION 'TOKEN_INVALIDO';
  END IF;
  IF p_lat IS NULL OR p_lon IS NULL THEN
    RAISE EXCEPTION 'LAT_LON_REQUERIDOS';
  END IF;
  IF p_lat < -90 OR p_lat > 90 OR p_lon < -180 OR p_lon > 180 THEN
    RAISE EXCEPTION 'COORDENADAS_FUERA_RANGO';
  END IF;

  SELECT id INTO v_rider_id FROM delivery_riders
   WHERE rider_token = p_rider_token AND deleted_at IS NULL AND activo = TRUE;
  IF v_rider_id IS NULL THEN
    RAISE EXCEPTION 'TOKEN_REVOCADO_O_INVALIDO';
  END IF;

  INSERT INTO rider_positions (
    rider_id, lat, lon, accuracy_m, speed_kmh, heading_deg, battery_pct,
    captured_at, server_received_at
  ) VALUES (
    v_rider_id, p_lat, p_lon, p_accuracy_m, p_speed_kmh, p_heading_deg, p_battery_pct,
    v_captured, v_now
  );

  UPDATE delivery_riders SET
    last_lat = p_lat,
    last_lon = p_lon,
    last_accuracy_m = p_accuracy_m,
    last_battery_pct = p_battery_pct,
    last_seen_at = v_now,
    updated_at = v_now
  WHERE id = v_rider_id;

  RETURN QUERY SELECT v_rider_id, TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_actualizar_posicion_rider(TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, INTEGER, TIMESTAMPTZ) TO anon;
GRANT EXECUTE ON FUNCTION fn_actualizar_posicion_rider(TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, INTEGER, TIMESTAMPTZ) TO authenticated;

-- ─── Toggle online del rider (público — auth por token) ───────────────
--
-- El rider en su PWA toca el switch "Estoy online" → se llama esta fn.
-- Sin parámetros más allá del token.
CREATE OR REPLACE FUNCTION fn_toggle_rider_online(
  p_rider_token TEXT,
  p_online BOOLEAN
) RETURNS TABLE (rider_id BIGINT, online BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_rider_id BIGINT;
BEGIN
  SELECT id INTO v_rider_id FROM delivery_riders
   WHERE rider_token = p_rider_token AND deleted_at IS NULL AND activo = TRUE;
  IF v_rider_id IS NULL THEN
    RAISE EXCEPTION 'TOKEN_REVOCADO_O_INVALIDO';
  END IF;

  UPDATE delivery_riders SET online = p_online, updated_at = NOW()
   WHERE id = v_rider_id;

  RETURN QUERY SELECT v_rider_id, p_online;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_toggle_rider_online(TEXT, BOOLEAN) TO anon;
GRANT EXECUTE ON FUNCTION fn_toggle_rider_online(TEXT, BOOLEAN) TO authenticated;

-- ─── Asignar pedido a rider (con permisos) ────────────────────────────
CREATE OR REPLACE FUNCTION fn_asignar_pedido_rider(
  p_venta_id BIGINT,
  p_rider_id BIGINT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id_venta INTEGER;
  v_local_id_rider INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT local_id INTO v_local_id_venta FROM ventas_pos
   WHERE id = p_venta_id AND tenant_id = v_tenant_id AND deleted_at IS NULL;
  IF v_local_id_venta IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  SELECT local_id INTO v_local_id_rider FROM delivery_riders
   WHERE id = p_rider_id AND tenant_id = v_tenant_id AND deleted_at IS NULL AND activo = TRUE;
  IF v_local_id_rider IS NULL THEN RAISE EXCEPTION 'RIDER_NO_ENCONTRADO'; END IF;

  IF v_local_id_venta != v_local_id_rider THEN
    RAISE EXCEPTION 'RIDER_DE_OTRO_LOCAL';
  END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id_venta = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Limpiar el current_venta_id del rider anterior (si tenía otro asignado)
  -- y del actual rider si tenía otro pedido (multi-pedido por ahora 1 a la vez).
  -- eslint-disable-next-line pase-local/no-direct-financiera-write -- delivery_riders no es financiera
  UPDATE delivery_riders SET current_venta_id = NULL, updated_at = NOW()
   WHERE current_venta_id = p_venta_id OR id = p_rider_id;

  UPDATE delivery_riders SET current_venta_id = p_venta_id, updated_at = NOW()
   WHERE id = p_rider_id;

  -- Marcar la venta con el rider asignado
  UPDATE ventas_pos SET
    rider_id = p_rider_id,
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_asignar_pedido_rider(BIGINT, BIGINT) TO authenticated;

-- ─── Columna rider_id en ventas_pos ───────────────────────────────────
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS rider_id BIGINT REFERENCES delivery_riders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_rider
  ON ventas_pos(rider_id) WHERE rider_id IS NOT NULL;

-- ─── Vista helper para UI: pedidos en delivery + posición rider ───────
CREATE OR REPLACE VIEW v_pedidos_delivery_mapa AS
SELECT
  v.id AS venta_id,
  v.tenant_id,
  v.local_id,
  v.numero_local,
  v.estado,
  v.tipo_entrega,
  v.cliente_nombre,
  v.cliente_telefono,
  v.cliente_direccion,
  v.cliente_lat,
  v.cliente_lon,
  v.programada_para,
  v.enviada_at,
  v.total,
  v.notas,
  v.rider_id,
  r.nombre AS rider_nombre,
  r.last_lat AS rider_lat,
  r.last_lon AS rider_lon,
  r.last_seen_at AS rider_last_seen_at,
  r.online AS rider_online,
  -- Minutos desde que se aprobó (útil para colorear urgencia)
  CASE
    WHEN v.enviada_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (NOW() - v.enviada_at)) / 60
  END AS minutos_desde_enviada
FROM ventas_pos v
LEFT JOIN delivery_riders r ON r.id = v.rider_id AND r.deleted_at IS NULL
WHERE v.tipo_entrega = 'delivery'
  AND v.estado IN ('enviada', 'lista')
  AND v.deleted_at IS NULL;

GRANT SELECT ON v_pedidos_delivery_mapa TO authenticated;

-- ─── Vista riders status (online/offline derivado) ────────────────────
CREATE OR REPLACE VIEW v_riders_status AS
SELECT
  r.id,
  r.tenant_id,
  r.local_id,
  r.nombre,
  r.telefono,
  r.foto_url,
  r.activo,
  r.online,
  r.last_seen_at,
  r.last_lat,
  r.last_lon,
  r.last_accuracy_m,
  r.last_battery_pct,
  r.current_venta_id,
  -- Status derivado: online si toggle ON + last_seen < 2min
  CASE
    WHEN NOT r.activo THEN 'inactivo'
    WHEN NOT r.online THEN 'offline'
    WHEN r.last_seen_at IS NULL THEN 'sin_reportar'
    WHEN r.last_seen_at > NOW() - INTERVAL '2 minutes' THEN 'en_linea'
    WHEN r.last_seen_at > NOW() - INTERVAL '10 minutes' THEN 'reciente'
    ELSE 'desconectado'
  END AS status,
  -- Si tiene pedido asignado, traer datos del cliente para el dispatch
  v.numero_local AS pedido_numero,
  v.cliente_nombre AS pedido_cliente,
  v.cliente_lat AS pedido_lat,
  v.cliente_lon AS pedido_lon,
  v.cliente_direccion AS pedido_direccion
FROM delivery_riders r
LEFT JOIN ventas_pos v ON v.id = r.current_venta_id AND v.deleted_at IS NULL
WHERE r.deleted_at IS NULL;

GRANT SELECT ON v_riders_status TO authenticated;

-- ─── Vista pública para tracking del cliente ──────────────────────────
--
-- Se llama desde la pantalla pública de tracking del cliente (sin auth).
-- Solo expone lo mínimo: la última posición del rider asignado al pedido.
-- No expone otros pedidos / otros riders.
CREATE OR REPLACE FUNCTION fn_get_rider_position_publico(
  p_venta_id BIGINT,
  p_telefono TEXT
) RETURNS TABLE (
  rider_nombre TEXT,
  rider_lat NUMERIC,
  rider_lon NUMERIC,
  rider_last_seen_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
BEGIN
  -- Validar que el cliente es dueño del pedido (mismo teléfono)
  IF NOT EXISTS (
    SELECT 1 FROM ventas_pos
    WHERE id = p_venta_id
      AND cliente_telefono = p_telefono
      AND deleted_at IS NULL
  ) THEN
    -- Devolver vacío (no exponer existencia / no exponer error)
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    r.nombre,
    r.last_lat,
    r.last_lon,
    r.last_seen_at
  FROM ventas_pos v
  INNER JOIN delivery_riders r ON r.id = v.rider_id AND r.deleted_at IS NULL
  WHERE v.id = p_venta_id
    AND r.online = TRUE
    AND r.last_seen_at > NOW() - INTERVAL '5 minutes';
END;
$$;
GRANT EXECUTE ON FUNCTION fn_get_rider_position_publico(BIGINT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_get_rider_position_publico(BIGINT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
