-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 4 — Sesión B
-- Tienda online (extender vistas existentes) + KDS + Menú QR + Reportes.
--
-- Pre-existente (NO duplicar): v_catalogo_publico, v_locales_publicos,
-- fn_crear_pedido_publico_comanda, fn_aprobar_pedido_comanda,
-- fn_marcar_listo_comanda, fn_marcar_entregado_comanda, fn_next_ticket_number_comanda.
--
-- Nuevo en esta migration:
--   - kds_tokens, menu_qr_tokens (tablas)
--   - v_locales_publicos extendida con features_pos_modos
--   - v_catalogo_menu_qr_publico (nueva)
--   - v_kds_tickets + fn_kds_* (3 RPCs anon)
--   - fn_get_pedido_publico_comanda (tracking público)
--   - fn_crear_pedido_menu_qr_comanda (pedidos desde mesa)
--   - fn_reporte_*_comanda (3 RPCs reportes)
--   - Backfill heurístico de item_grupos.estacion_default
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Tablas de tokens ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kds_tokens (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL,
  estacion      TEXT NOT NULL CHECK (estacion IN ('cocina_caliente','cocina_fria','barra','postres')),
  token         TEXT NOT NULL,
  last_used_at  TIMESTAMPTZ NULL,
  CONSTRAINT uniq_kds_token UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_kds_tokens_local_estacion
  ON kds_tokens(local_id, estacion) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kds_estacion_per_local
  ON kds_tokens(local_id, estacion) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_kds_tokens_set_updated_at ON kds_tokens;
CREATE TRIGGER trg_kds_tokens_set_updated_at BEFORE UPDATE ON kds_tokens
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE kds_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kds_tokens_select ON kds_tokens;
CREATE POLICY kds_tokens_select ON kds_tokens FOR SELECT USING (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
    AND deleted_at IS NULL
  )
);

DROP POLICY IF EXISTS kds_tokens_modify ON kds_tokens;
CREATE POLICY kds_tokens_modify ON kds_tokens FOR ALL USING (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND auth_tiene_permiso('comanda.config.editar')
  )
) WITH CHECK (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND auth_tiene_permiso('comanda.config.editar')
  )
);

GRANT SELECT, INSERT, UPDATE ON kds_tokens TO authenticated;
GRANT USAGE ON SEQUENCE kds_tokens_id_seq TO authenticated;

CREATE TABLE IF NOT EXISTS menu_qr_tokens (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  mesa_id       BIGINT NOT NULL REFERENCES mesas(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  token         TEXT NOT NULL,
  modo          TEXT NOT NULL DEFAULT 'asistido' CHECK (modo IN ('readonly','asistido','autonomo')),
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at  TIMESTAMPTZ NULL,
  CONSTRAINT uniq_menu_qr_token UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_menu_qr_mesa
  ON menu_qr_tokens(mesa_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_menu_qr_local
  ON menu_qr_tokens(local_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_menu_qr_tokens_set_updated_at ON menu_qr_tokens;
CREATE TRIGGER trg_menu_qr_tokens_set_updated_at BEFORE UPDATE ON menu_qr_tokens
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE menu_qr_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS menu_qr_tokens_select ON menu_qr_tokens;
CREATE POLICY menu_qr_tokens_select ON menu_qr_tokens FOR SELECT USING (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
    AND deleted_at IS NULL
  )
);

DROP POLICY IF EXISTS menu_qr_tokens_modify ON menu_qr_tokens;
CREATE POLICY menu_qr_tokens_modify ON menu_qr_tokens FOR ALL USING (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND auth_tiene_permiso('comanda.config.editar')
  )
) WITH CHECK (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND auth_tiene_permiso('comanda.config.editar')
  )
);

GRANT SELECT, INSERT, UPDATE ON menu_qr_tokens TO authenticated;
GRANT USAGE ON SEQUENCE menu_qr_tokens_id_seq TO authenticated;

-- ─── Vistas públicas ───────────────────────────────────────────────────────

-- Extender v_locales_publicos: agregar features_pos_modos (necesario para que
-- la tienda decida si acepta pedidos online).
CREATE OR REPLACE VIEW v_locales_publicos AS
SELECT
  cls.local_id,
  cls.slug,
  l.nombre,
  cls.direccion,
  cls.telefono,
  cls.instagram,
  cls.web,
  cls.mp_qr_url,
  cls.costo_envio_default,
  cls.tiempo_retiro_min,
  cls.tiempo_delivery_min,
  cls.tienda_activa,
  cls.acepta_delivery,
  cls.features_pos_modos
FROM comanda_local_settings cls
JOIN locales l ON l.id = cls.local_id
WHERE cls.deleted_at IS NULL
  AND cls.tienda_activa = TRUE;

GRANT SELECT ON v_locales_publicos TO anon, authenticated;

-- Catálogo para menú QR. NO filtra por slug; el servidor valida el token y
-- expone el catálogo del local correspondiente.
CREATE OR REPLACE VIEW v_catalogo_menu_qr_publico AS
SELECT
  i.id AS item_id,
  i.tenant_id,
  i.local_id,
  i.nombre,
  i.descripcion,
  i.emoji,
  i.foto_url,
  i.precio_madre AS precio,
  g.id AS grupo_id,
  g.nombre AS grupo_nombre,
  g.emoji AS grupo_emoji,
  g.color_ramp AS grupo_color_ramp,
  g.orden AS grupo_orden
FROM items i
LEFT JOIN item_grupos g ON i.grupo_id = g.id AND g.deleted_at IS NULL
WHERE i.deleted_at IS NULL
  AND i.estado = 'disponible'
  AND i.visible_qr = TRUE;

-- No grant a anon: se accede vía RPC con token (SECURITY DEFINER bypassa RLS).

-- Vista de tickets KDS (interna, accedida vía RPC con token).
CREATE OR REPLACE VIEW v_kds_tickets AS
SELECT
  vpi.id AS item_id,
  vpi.venta_id,
  vpi.cantidad,
  vpi.modificadores,
  vpi.curso,
  vpi.estado,
  vpi.enviado_at,
  vpi.notas,
  vpi.local_id,
  COALESCE(i.estacion, g.estacion_default, 'cocina_caliente') AS estacion,
  i.nombre AS item_nombre,
  i.emoji AS item_emoji,
  vp.numero_local AS venta_numero,
  vp.modo,
  vp.mesa_id,
  vp.cliente_nombre,
  vp.notas AS venta_notas,
  m.numero AS mesa_numero,
  m.zona AS mesa_zona,
  COALESCE(e.nombre, '') AS mozo_nombre,
  EXTRACT(EPOCH FROM (NOW() - vpi.enviado_at))::INTEGER AS segundos_desde_enviado
FROM ventas_pos_items vpi
JOIN items i ON vpi.item_id = i.id
LEFT JOIN item_grupos g ON i.grupo_id = g.id
JOIN ventas_pos vp ON vpi.venta_id = vp.id
LEFT JOIN mesas m ON vp.mesa_id = m.id
LEFT JOIN rrhh_empleados e ON vp.mozo_id = e.id
WHERE vpi.deleted_at IS NULL
  AND vpi.estado IN ('enviado', 'listo')
  AND vpi.enviado_at IS NOT NULL;

-- ─── RPCs KDS (anon, validan via token) ────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_kds_get_tickets_comanda(p_token TEXT)
RETURNS TABLE (
  item_id BIGINT, venta_id BIGINT, cantidad NUMERIC, modificadores JSONB,
  curso INTEGER, estado TEXT, enviado_at TIMESTAMPTZ, notas TEXT,
  estacion TEXT, item_nombre TEXT, item_emoji TEXT, venta_numero INTEGER,
  modo TEXT, mesa_numero TEXT, mesa_zona TEXT, cliente_nombre TEXT,
  mozo_nombre TEXT, segundos_desde_enviado INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token RECORD;
BEGIN
  SELECT t.local_id, t.estacion INTO v_token
  FROM kds_tokens t WHERE t.token = p_token AND t.deleted_at IS NULL;
  IF v_token IS NULL THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;

  UPDATE kds_tokens SET last_used_at = NOW() WHERE token = p_token;

  RETURN QUERY
    SELECT
      v.item_id, v.venta_id, v.cantidad, v.modificadores, v.curso, v.estado,
      v.enviado_at, v.notas, v.estacion, v.item_nombre, v.item_emoji,
      v.venta_numero, v.modo, v.mesa_numero, v.mesa_zona, v.cliente_nombre,
      v.mozo_nombre, v.segundos_desde_enviado
    FROM v_kds_tickets v
    WHERE v.local_id = v_token.local_id AND v.estacion = v_token.estacion
    ORDER BY v.enviado_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_kds_get_tickets_comanda(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION fn_kds_marcar_listo_comanda(p_token TEXT, p_item_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_token RECORD; v_item_estacion TEXT;
BEGIN
  SELECT t.local_id, t.estacion INTO v_token
  FROM kds_tokens t WHERE t.token = p_token AND t.deleted_at IS NULL;
  IF v_token IS NULL THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;

  SELECT COALESCE(i.estacion, g.estacion_default, 'cocina_caliente') INTO v_item_estacion
  FROM ventas_pos_items vpi
  JOIN items i ON vpi.item_id = i.id
  LEFT JOIN item_grupos g ON i.grupo_id = g.id
  WHERE vpi.id = p_item_id AND vpi.local_id = v_token.local_id;

  IF v_item_estacion IS NULL OR v_item_estacion <> v_token.estacion THEN
    RAISE EXCEPTION 'ITEM_NO_PERTENECE_A_ESTACION';
  END IF;

  UPDATE ventas_pos_items
     SET estado = 'listo', listo_at = NOW(), updated_at = NOW()
   WHERE id = p_item_id AND estado = 'enviado';

  IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NO_ENVIADO_O_YA_LISTO'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_kds_marcar_listo_comanda(TEXT, BIGINT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION fn_kds_recall_comanda(p_token TEXT, p_item_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_token RECORD;
BEGIN
  SELECT t.local_id INTO v_token
  FROM kds_tokens t WHERE t.token = p_token AND t.deleted_at IS NULL;
  IF v_token IS NULL THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;

  UPDATE ventas_pos_items
     SET estado = 'enviado', listo_at = NULL, updated_at = NOW()
   WHERE id = p_item_id
     AND estado = 'listo'
     AND listo_at > NOW() - INTERVAL '60 seconds'
     AND local_id = v_token.local_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'RECALL_VENTANA_60S_VENCIDA'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_kds_recall_comanda(TEXT, BIGINT) TO anon, authenticated;

-- ─── RPC tracking público ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_get_pedido_publico_comanda(
  p_venta_id BIGINT, p_telefono TEXT
) RETURNS TABLE (
  estado TEXT, numero_local INTEGER, total NUMERIC,
  programada_para TIMESTAMPTZ, tipo_entrega TEXT, abierta_at TIMESTAMPTZ,
  rechazo_motivo TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT v.estado, v.numero_local, v.total, v.programada_para,
           v.tipo_entrega, v.abierta_at, NULL::TEXT
      FROM ventas_pos v
     WHERE v.id = p_venta_id
       AND v.cliente_telefono = p_telefono
       AND v.origen = 'tienda_online'
       AND v.deleted_at IS NULL
     LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_get_pedido_publico_comanda(BIGINT, TEXT) TO anon, authenticated;

-- ─── RPCs Menú QR ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_menu_qr_get_local_comanda(p_token TEXT)
RETURNS TABLE (
  local_id INTEGER, local_nombre TEXT, mesa_id BIGINT, mesa_numero TEXT,
  mesa_zona TEXT, modo TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_token RECORD;
BEGIN
  SELECT mqt.local_id, mqt.mesa_id, mqt.modo, mqt.activo INTO v_token
  FROM menu_qr_tokens mqt
  WHERE mqt.token = p_token AND mqt.deleted_at IS NULL;
  IF v_token IS NULL OR NOT v_token.activo THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;

  UPDATE menu_qr_tokens SET last_used_at = NOW() WHERE token = p_token;

  RETURN QUERY
    SELECT l.id, l.nombre, m.id, m.numero, m.zona, v_token.modo
      FROM locales l, mesas m
     WHERE l.id = v_token.local_id AND m.id = v_token.mesa_id
     LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_menu_qr_get_local_comanda(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION fn_menu_qr_get_catalogo_comanda(p_token TEXT)
RETURNS TABLE (
  item_id INTEGER, nombre TEXT, descripcion TEXT, emoji TEXT, foto_url TEXT,
  precio NUMERIC, grupo_id INTEGER, grupo_nombre TEXT, grupo_emoji TEXT,
  grupo_color_ramp TEXT, grupo_orden INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_token RECORD;
BEGIN
  SELECT mqt.local_id INTO v_token
  FROM menu_qr_tokens mqt
  WHERE mqt.token = p_token AND mqt.deleted_at IS NULL AND mqt.activo = TRUE;
  IF v_token IS NULL THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;

  RETURN QUERY
    SELECT v.item_id, v.nombre, v.descripcion, v.emoji, v.foto_url, v.precio,
           v.grupo_id, v.grupo_nombre, v.grupo_emoji, v.grupo_color_ramp,
           v.grupo_orden
      FROM v_catalogo_menu_qr_publico v
     WHERE v.local_id = v_token.local_id
     ORDER BY v.grupo_orden NULLS LAST, v.nombre;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_menu_qr_get_catalogo_comanda(TEXT) TO anon, authenticated;

-- Crear pedido desde menú QR (modo asistido o autónomo).
-- 'asistido' → estado='necesita_aprobacion' (mozo aprueba en POS).
-- 'autonomo' → estado='enviada' + items en 'enviado' (van directo a KDS).
CREATE OR REPLACE FUNCTION fn_crear_pedido_menu_qr_comanda(
  p_token TEXT,
  p_items JSONB,
  p_idempotency_key TEXT,
  p_notas TEXT DEFAULT NULL
) RETURNS TABLE (venta_id BIGINT, numero_local INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token RECORD;
  v_venta_id BIGINT;
  v_numero INTEGER;
  v_canal_id INTEGER;
  v_tenant UUID;
  v_subtotal NUMERIC := 0;
  v_item JSONB;
  v_estado_venta TEXT;
  v_estado_item TEXT;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT mqt.local_id, mqt.mesa_id, mqt.modo, mqt.activo, mqt.tenant_id INTO v_token
  FROM menu_qr_tokens mqt
  WHERE mqt.token = p_token AND mqt.deleted_at IS NULL;
  IF v_token IS NULL OR NOT v_token.activo THEN RAISE EXCEPTION 'TOKEN_INVALIDO'; END IF;
  IF v_token.modo = 'readonly' THEN RAISE EXCEPTION 'MODO_READONLY_NO_PERMITE_PEDIDOS'; END IF;

  v_tenant := v_token.tenant_id;

  -- Idempotency: si ya existe una venta con esa key en notas, devolverla.
  SELECT v.id, v.numero_local INTO v_venta_id, v_numero
  FROM ventas_pos v
  WHERE v.notas LIKE '%idempotency:' || p_idempotency_key || '%'
    AND v.local_id = v_token.local_id
  LIMIT 1;
  IF v_venta_id IS NOT NULL THEN
    RETURN QUERY SELECT v_venta_id, v_numero;
    RETURN;
  END IF;

  SELECT c.id INTO v_canal_id
  FROM canales c
  WHERE c.tenant_id = v_tenant AND c.slug = 'menu-qr'
    AND c.deleted_at IS NULL AND c.activo = TRUE
  LIMIT 1;
  IF v_canal_id IS NULL THEN RAISE EXCEPTION 'CANAL_MENU_QR_NO_CONFIGURADO'; END IF;

  IF v_token.modo = 'autonomo' THEN
    v_estado_venta := 'enviada';
    v_estado_item := 'enviado';
  ELSE
    v_estado_venta := 'necesita_aprobacion';
    v_estado_item := 'hold';
  END IF;

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id, mesa_id,
    estado, origen, abierta_at, enviada_at, notas
  ) VALUES (
    v_tenant, v_token.local_id, fn_next_ticket_number_comanda(v_token.local_id),
    'salon', v_canal_id, v_token.mesa_id,
    v_estado_venta, 'menu_qr', v_now,
    CASE WHEN v_estado_venta = 'enviada' THEN v_now ELSE NULL END,
    COALESCE(p_notas, '') || ' [idempotency:' || p_idempotency_key || ']'
  ) RETURNING id, numero_local INTO v_venta_id, v_numero;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO ventas_pos_items (
      tenant_id, local_id, venta_id, item_id, cantidad,
      precio_unitario, subtotal, modificadores, notas, estado, curso,
      enviado_at
    )
    SELECT
      v_tenant, v_token.local_id, v_venta_id, (v_item->>'item_id')::INTEGER,
      (v_item->>'cantidad')::NUMERIC,
      i.precio_madre,
      i.precio_madre * (v_item->>'cantidad')::NUMERIC,
      v_item->'modificadores',
      v_item->>'notas',
      v_estado_item, 1,
      CASE WHEN v_estado_item = 'enviado' THEN v_now ELSE NULL END
    FROM items i
    WHERE i.id = (v_item->>'item_id')::INTEGER;

    v_subtotal := v_subtotal +
      (SELECT i.precio_madre * (v_item->>'cantidad')::NUMERIC
       FROM items i WHERE i.id = (v_item->>'item_id')::INTEGER);
  END LOOP;

  UPDATE ventas_pos SET subtotal = v_subtotal, total = v_subtotal
  WHERE id = v_venta_id;

  RETURN QUERY SELECT v_venta_id, v_numero;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_crear_pedido_menu_qr_comanda(TEXT, JSONB, TEXT, TEXT) TO anon, authenticated;

-- ─── RPCs reportes (authenticated, validan permiso) ───────────────────────

CREATE OR REPLACE FUNCTION fn_reporte_ventas_por_canal_comanda(
  p_local_id INTEGER, p_desde TIMESTAMPTZ, p_hasta TIMESTAMPTZ
) RETURNS TABLE (
  canal_id INTEGER, canal_nombre TEXT, canal_color TEXT,
  cantidad_ventas BIGINT, total_ventas NUMERIC, ticket_promedio NUMERIC,
  comision_pct NUMERIC, comision_total NUMERIC, margen_neto NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() AND NOT auth_tiene_permiso('comanda.reportes.ver') THEN
    RAISE EXCEPTION 'SIN_PERMISO_REPORTES';
  END IF;

  RETURN QUERY
    SELECT
      c.id, c.nombre, c.color,
      COUNT(v.id),
      COALESCE(SUM(v.total), 0),
      CASE WHEN COUNT(v.id) > 0 THEN COALESCE(SUM(v.total), 0) / COUNT(v.id) ELSE 0 END,
      c.comision_externa_pct,
      COALESCE(SUM(v.total * c.comision_externa_pct / 100.0), 0),
      COALESCE(SUM(v.total * (1 - c.comision_externa_pct / 100.0)), 0)
    FROM canales c
    LEFT JOIN ventas_pos v ON v.canal_id = c.id
      AND v.local_id = p_local_id
      AND v.estado = 'cobrada'
      AND v.cobrada_at BETWEEN p_desde AND p_hasta
      AND v.deleted_at IS NULL
    WHERE c.tenant_id = auth_tenant_id()
      AND (c.local_id = p_local_id OR c.local_id IS NULL)
      AND c.deleted_at IS NULL
    GROUP BY c.id, c.nombre, c.color, c.comision_externa_pct
    ORDER BY 5 DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_ventas_por_canal_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION fn_reporte_top_productos_comanda(
  p_local_id INTEGER, p_desde TIMESTAMPTZ, p_hasta TIMESTAMPTZ, p_limit INTEGER DEFAULT 20
) RETURNS TABLE (
  item_id INTEGER, item_nombre TEXT, item_emoji TEXT,
  cantidad_vendida NUMERIC, total_facturado NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() AND NOT auth_tiene_permiso('comanda.reportes.ver') THEN
    RAISE EXCEPTION 'SIN_PERMISO_REPORTES';
  END IF;

  RETURN QUERY
    SELECT i.id, i.nombre, i.emoji,
           SUM(vpi.cantidad)::NUMERIC,
           SUM(vpi.subtotal)::NUMERIC
      FROM ventas_pos_items vpi
      JOIN items i ON vpi.item_id = i.id
      JOIN ventas_pos v ON vpi.venta_id = v.id
     WHERE v.local_id = p_local_id
       AND v.estado = 'cobrada'
       AND v.cobrada_at BETWEEN p_desde AND p_hasta
       AND vpi.estado <> 'anulado'
       AND vpi.deleted_at IS NULL
     GROUP BY i.id, i.nombre, i.emoji
     ORDER BY SUM(vpi.cantidad) DESC
     LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_top_productos_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION fn_reporte_tiempos_comanda(
  p_local_id INTEGER, p_desde TIMESTAMPTZ, p_hasta TIMESTAMPTZ
) RETURNS TABLE (
  tiempo_promedio_cocina_seg NUMERIC, tiempo_promedio_cobro_seg NUMERIC,
  cantidad_ventas BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() AND NOT auth_tiene_permiso('comanda.reportes.ver') THEN
    RAISE EXCEPTION 'SIN_PERMISO_REPORTES';
  END IF;

  RETURN QUERY
    SELECT
      AVG(EXTRACT(EPOCH FROM (vpi.listo_at - vpi.enviado_at)))::NUMERIC,
      AVG(EXTRACT(EPOCH FROM (v.cobrada_at - v.abierta_at)))::NUMERIC,
      COUNT(DISTINCT v.id)
    FROM ventas_pos v
    LEFT JOIN ventas_pos_items vpi ON vpi.venta_id = v.id
      AND vpi.listo_at IS NOT NULL AND vpi.enviado_at IS NOT NULL
   WHERE v.local_id = p_local_id
     AND v.estado = 'cobrada'
     AND v.cobrada_at BETWEEN p_desde AND p_hasta;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_tiempos_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- KPIs agregados del día (cantidad ventas, total, ticket promedio).
CREATE OR REPLACE FUNCTION fn_reporte_kpis_periodo_comanda(
  p_local_id INTEGER, p_desde TIMESTAMPTZ, p_hasta TIMESTAMPTZ
) RETURNS TABLE (
  total_ventas NUMERIC, cantidad_ventas BIGINT, ticket_promedio NUMERIC,
  cantidad_productos NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() AND NOT auth_tiene_permiso('comanda.reportes.ver') THEN
    RAISE EXCEPTION 'SIN_PERMISO_REPORTES';
  END IF;

  RETURN QUERY
    SELECT
      COALESCE(SUM(v.total), 0),
      COUNT(v.id),
      CASE WHEN COUNT(v.id) > 0 THEN COALESCE(SUM(v.total), 0) / COUNT(v.id) ELSE 0 END,
      COALESCE((SELECT SUM(vpi.cantidad)
                  FROM ventas_pos_items vpi
                  JOIN ventas_pos vp ON vpi.venta_id = vp.id
                 WHERE vp.local_id = p_local_id
                   AND vp.estado = 'cobrada'
                   AND vp.cobrada_at BETWEEN p_desde AND p_hasta
                   AND vpi.estado <> 'anulado'
                   AND vpi.deleted_at IS NULL), 0)
      FROM ventas_pos v
     WHERE v.local_id = p_local_id
       AND v.estado = 'cobrada'
       AND v.cobrada_at BETWEEN p_desde AND p_hasta
       AND v.deleted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_reporte_kpis_periodo_comanda(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ─── Backfill heurístico estación default en grupos ───────────────────────

UPDATE item_grupos SET estacion_default = 'barra'
 WHERE estacion_default IS NULL
   AND deleted_at IS NULL
   AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%cerveza%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%vino%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%coctel%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%trago%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%bebida%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%cafe%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%aperitivo%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%gaseosa%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%agua%');

UPDATE item_grupos SET estacion_default = 'postres'
 WHERE estacion_default IS NULL
   AND deleted_at IS NULL
   AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%postre%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%helado%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%dulce%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%torta%');

UPDATE item_grupos SET estacion_default = 'cocina_fria'
 WHERE estacion_default IS NULL
   AND deleted_at IS NULL
   AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%ensalada%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%entrada fria%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%picada%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%tabla%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%sandwich%'
     OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%wrap%');

UPDATE item_grupos SET estacion_default = 'cocina_caliente'
 WHERE estacion_default IS NULL AND deleted_at IS NULL;

DO $$
DECLARE v_cc INT; v_cf INT; v_b INT; v_p INT;
BEGIN
  SELECT count(*) INTO v_cc FROM item_grupos WHERE estacion_default = 'cocina_caliente' AND deleted_at IS NULL;
  SELECT count(*) INTO v_cf FROM item_grupos WHERE estacion_default = 'cocina_fria' AND deleted_at IS NULL;
  SELECT count(*) INTO v_b  FROM item_grupos WHERE estacion_default = 'barra' AND deleted_at IS NULL;
  SELECT count(*) INTO v_p  FROM item_grupos WHERE estacion_default = 'postres' AND deleted_at IS NULL;
  RAISE NOTICE '[backfill estacion] cocina_caliente=%, cocina_fria=%, barra=%, postres=%', v_cc, v_cf, v_b, v_p;
END$$;
