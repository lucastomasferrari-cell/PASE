-- ═══════════════════════════════════════════════════════════════════════════
-- Auto-confirmar entrega por geofencing
--
-- Cuando el rider asignado a un pedido entra en radio de 200m del cliente
-- Y lleva 5+ minutos dentro de ese radio (sumando varias posiciones), se
-- marca automáticamente como `entregada`. Pasados 5 minutos para evitar
-- false positives cuando el rider solo pasa cerca pero no se detiene.
--
-- Trigger: AFTER INSERT en rider_positions. Por cada nueva posición,
-- evaluamos si dispara auto-entrega para el pedido del rider.
--
-- Constantes:
--   AUTO_ENTREGA_RADIUS_M = 200        (~ 2 cuadras urbanas)
--   AUTO_ENTREGA_MIN_TIME = 5 minutos  (debe estar al menos 5min en el radio)
-- ═══════════════════════════════════════════════════════════════════════════

-- Helper haversine en metros (asume coords en grados)
CREATE OR REPLACE FUNCTION fn_haversine_m(lat1 NUMERIC, lon1 NUMERIC, lat2 NUMERIC, lon2 NUMERIC)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_R NUMERIC := 6371000; -- radio tierra metros
  v_dlat NUMERIC; v_dlon NUMERIC; v_a NUMERIC; v_c NUMERIC;
BEGIN
  v_dlat := radians(lat2 - lat1);
  v_dlon := radians(lon2 - lon1);
  v_a := sin(v_dlat/2)*sin(v_dlat/2) +
         cos(radians(lat1)) * cos(radians(lat2)) * sin(v_dlon/2)*sin(v_dlon/2);
  v_c := 2 * atan2(sqrt(v_a), sqrt(1 - v_a));
  RETURN v_R * v_c;
END;
$$;

-- ─── Trigger: chequea auto-entrega después de cada posición nueva ─────
CREATE OR REPLACE FUNCTION trg_auto_entrega_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_cliente_lat NUMERIC;
  v_cliente_lon NUMERIC;
  v_estado TEXT;
  v_distancia_m NUMERIC;
  v_first_close_at TIMESTAMPTZ;
  v_minutos NUMERIC;
  RADIUS_M CONSTANT NUMERIC := 200;
  MIN_MINUTES CONSTANT NUMERIC := 5;
BEGIN
  -- Buscar pedido del rider (si tiene)
  SELECT v.id, v.local_id, v.cliente_lat, v.cliente_lon, v.estado
    INTO v_venta_id, v_local_id, v_cliente_lat, v_cliente_lon, v_estado
    FROM delivery_riders r
    INNER JOIN ventas_pos v ON v.id = r.current_venta_id AND v.deleted_at IS NULL
   WHERE r.id = NEW.rider_id
     AND r.deleted_at IS NULL
     AND v.tipo_entrega = 'delivery'
     AND v.estado IN ('enviada', 'lista');

  -- Sin pedido asignado o cliente sin coords → skip
  IF v_venta_id IS NULL OR v_cliente_lat IS NULL OR v_cliente_lon IS NULL THEN
    RETURN NEW;
  END IF;

  -- Distancia actual
  v_distancia_m := fn_haversine_m(NEW.lat, NEW.lon, v_cliente_lat, v_cliente_lon);

  -- Si está fuera del radio, nada que hacer
  IF v_distancia_m > RADIUS_M THEN
    RETURN NEW;
  END IF;

  -- Está dentro del radio. ¿Hace cuánto que entró por primera vez?
  -- Buscamos la primera posición consecutiva dentro del radio en los
  -- últimos 30 minutos (límite arbitrario para que no escanee toda la
  -- historia).
  SELECT MIN(captured_at) INTO v_first_close_at
    FROM rider_positions p
   WHERE p.rider_id = NEW.rider_id
     AND p.captured_at > NOW() - INTERVAL '30 minutes'
     AND fn_haversine_m(p.lat, p.lon, v_cliente_lat, v_cliente_lon) <= RADIUS_M;

  IF v_first_close_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_minutos := EXTRACT(EPOCH FROM (NOW() - v_first_close_at)) / 60;

  IF v_minutos < MIN_MINUTES THEN
    RETURN NEW;
  END IF;

  -- ✓ Cumple criterios → auto-entregar
  UPDATE ventas_pos SET
    estado = 'entregada',
    updated_at = NOW()
  WHERE id = v_venta_id AND estado IN ('enviada', 'lista');

  -- Liberar al rider
  UPDATE delivery_riders SET
    current_venta_id = NULL,
    updated_at = NOW()
  WHERE id = NEW.rider_id;

  -- Insert en log para auditoría (tabla nueva, abajo)
  INSERT INTO auto_entrega_log (venta_id, rider_id, distancia_m, minutos_en_radio, lat, lon)
  VALUES (v_venta_id, NEW.rider_id, v_distancia_m, v_minutos, NEW.lat, NEW.lon);

  RETURN NEW;
END;
$$;

-- ─── Tabla log para auditoría ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_entrega_log (
  id          BIGSERIAL PRIMARY KEY,
  venta_id    BIGINT NOT NULL,
  rider_id    BIGINT NOT NULL,
  distancia_m NUMERIC,
  minutos_en_radio NUMERIC,
  lat         NUMERIC(10, 7),
  lon         NUMERIC(10, 7),
  detectada_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE auto_entrega_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY auto_entrega_log_select ON auto_entrega_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ventas_pos v
      WHERE v.id = auto_entrega_log.venta_id
        AND v.tenant_id = auth_tenant_id()
        AND (auth_es_dueno_o_admin() OR v.local_id = ANY(auth_locales_visibles()))
    )
  );

-- ─── Instalar trigger ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS auto_entrega_check ON rider_positions;
CREATE TRIGGER auto_entrega_check
  AFTER INSERT ON rider_positions
  FOR EACH ROW EXECUTE FUNCTION trg_auto_entrega_check();

NOTIFY pgrst, 'reload schema';
