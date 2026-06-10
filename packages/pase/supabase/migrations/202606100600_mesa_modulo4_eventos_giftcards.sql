-- ════════════════════════════════════════════════════════════════════════
-- MESA · Módulo #4 (Fase 1 backend) — Eventos con prepago + Giftcards (09-jun).
-- Spec: docs/superpowers/specs/2026-06-09-mesa-modulo-4-pagina-publica-design.md
--
-- Decisión Lucas: cobro online MP desde v1, reusando la infra de la tienda
-- (mp_credenciales por local + api/tienda-mp.js). Acá va el modelo de datos +
-- RPCs. El routing de MP (preference/webhook) vive en tienda-mp.js.
--
-- Flujo de plata:
--   público → fn_inscribir_evento_publico / fn_comprar_giftcard_publica
--     (monto SERVER-side, fila en pendiente_pago)
--   → MP Checkout (action=evento-preference / giftcard-preference)
--   → webhook approved → fn_confirmar_pago_evento / fn_confirmar_pago_giftcard
--     (SOLO service_role; idempotente por payment; genera código de giftcard)
--   → staff canjea con fn_canjear_giftcard(codigo).
-- ════════════════════════════════════════════════════════════════════════

-- ─── Tablas ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eventos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  local_id INTEGER NOT NULL,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  foto_url TEXT,
  fecha_inicio TIMESTAMPTZ NOT NULL,
  fecha_fin TIMESTAMPTZ,
  precio_por_persona NUMERIC NOT NULL CHECK (precio_por_persona >= 0),
  cupos_total INTEGER NOT NULL CHECK (cupos_total > 0),
  cupos_vendidos INTEGER NOT NULL DEFAULT 0 CHECK (cupos_vendidos >= 0),
  estado TEXT NOT NULL DEFAULT 'borrador'
    CHECK (estado IN ('borrador','publicado','agotado','finalizado','cancelado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_eventos_local_fecha ON eventos (local_id, fecha_inicio)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS evento_inscripciones (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  local_id INTEGER NOT NULL,
  evento_id BIGINT NOT NULL REFERENCES eventos(id),
  nombre TEXT NOT NULL,
  telefono TEXT,
  email TEXT,
  cantidad INTEGER NOT NULL CHECK (cantidad BETWEEN 1 AND 20),
  monto_total NUMERIC NOT NULL CHECK (monto_total >= 0),
  estado TEXT NOT NULL DEFAULT 'pendiente_pago'
    CHECK (estado IN ('pendiente_pago','pagada','cancelada','reembolsada')),
  mp_payment_id TEXT,
  mp_preference_id TEXT,
  idempotency_key TEXT,
  pagada_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evento_insc_idem
  ON evento_inscripciones (evento_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evento_insc_evento ON evento_inscripciones (evento_id, estado);

CREATE TABLE IF NOT EXISTS giftcards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  local_id INTEGER,                    -- NULL = válida en todo el grupo
  nombre TEXT NOT NULL,
  descripcion TEXT,
  foto_url TEXT,
  precio NUMERIC NOT NULL CHECK (precio > 0),
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS giftcard_compras (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  local_id INTEGER NOT NULL,           -- local del slug donde se compró
  giftcard_id BIGINT NOT NULL REFERENCES giftcards(id),
  comprador_nombre TEXT NOT NULL,
  comprador_email TEXT,
  comprador_telefono TEXT,
  para_nombre TEXT,
  mensaje TEXT,
  codigo TEXT UNIQUE,                  -- se genera AL CONFIRMARSE el pago
  monto NUMERIC NOT NULL CHECK (monto > 0),
  estado TEXT NOT NULL DEFAULT 'pendiente_pago'
    CHECK (estado IN ('pendiente_pago','pagada','canjeada','cancelada')),
  mp_payment_id TEXT,
  mp_preference_id TEXT,
  idempotency_key TEXT,
  pagada_at TIMESTAMPTZ,
  canjeada_at TIMESTAMPTZ,
  canjeada_venta_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_giftcard_compra_idem
  ON giftcard_compras (giftcard_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ─── RLS (dual estándar) ───────────────────────────────────────────────────
ALTER TABLE eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento_inscripciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE giftcards ENABLE ROW LEVEL SECURITY;
ALTER TABLE giftcard_compras ENABLE ROW LEVEL SECURITY;

-- Catálogos: staff del tenant gestiona (dueño/admin o local visible).
DROP POLICY IF EXISTS eventos_rw ON eventos;
CREATE POLICY eventos_rw ON eventos FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

DROP POLICY IF EXISTS giftcards_rw ON giftcards;
CREATE POLICY giftcards_rw ON giftcards FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())));

-- Plata (inscripciones/compras): el staff SOLO LEE; escribe únicamente la RPC
-- pública (SECURITY DEFINER) y el webhook (service_role) — regla C4.
DROP POLICY IF EXISTS evento_insc_select ON evento_inscripciones;
CREATE POLICY evento_insc_select ON evento_inscripciones FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

DROP POLICY IF EXISTS giftcard_compras_select ON giftcard_compras;
CREATE POLICY giftcard_compras_select ON giftcard_compras FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

-- ─── RPCs públicas (anon, por slug del local) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_eventos_publicos(p_local_slug text)
RETURNS TABLE (
  id bigint, titulo text, descripcion text, foto_url text,
  fecha_inicio timestamptz, fecha_fin timestamptz,
  precio_por_persona numeric, cupos_disponibles integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT e.id, e.titulo, e.descripcion, e.foto_url, e.fecha_inicio, e.fecha_fin,
         e.precio_por_persona, GREATEST(0, e.cupos_total - e.cupos_vendidos) AS cupos_disponibles
    FROM eventos e
    JOIN comanda_local_settings cls ON cls.local_id = e.local_id
   WHERE cls.slug = p_local_slug
     AND e.estado = 'publicado'
     AND e.deleted_at IS NULL
     AND e.fecha_inicio > NOW()
   ORDER BY e.fecha_inicio;
$$;

CREATE OR REPLACE FUNCTION public.fn_inscribir_evento_publico(
  p_local_slug text,
  p_evento_id bigint,
  p_nombre text,
  p_telefono text,
  p_email text,
  p_cantidad integer,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_e eventos%ROWTYPE;
  v_pendientes integer;
  v_id bigint;
  v_monto numeric;
BEGIN
  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;
  IF p_email IS NULL OR trim(p_email) = '' THEN RAISE EXCEPTION 'EMAIL_REQUERIDO'; END IF;
  IF p_cantidad IS NULL OR p_cantidad < 1 OR p_cantidad > 20 THEN RAISE EXCEPTION 'CANTIDAD_INVALIDA'; END IF;

  -- Idempotency.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, monto_total INTO v_id, v_monto FROM evento_inscripciones
     WHERE evento_id = p_evento_id AND idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
      RETURN jsonb_build_object('inscripcion_id', v_id, 'monto_total', v_monto);
    END IF;
  END IF;

  -- Evento publicado, futuro, y del local del slug (lock para el chequeo de cupos).
  SELECT e.* INTO v_e
    FROM eventos e JOIN comanda_local_settings cls ON cls.local_id = e.local_id
   WHERE e.id = p_evento_id AND cls.slug = p_local_slug
     AND e.deleted_at IS NULL
   FOR UPDATE OF e;
  IF v_e.id IS NULL THEN RAISE EXCEPTION 'EVENTO_NO_ENCONTRADO'; END IF;
  IF v_e.estado != 'publicado' OR v_e.fecha_inicio <= NOW() THEN
    RAISE EXCEPTION 'EVENTO_NO_DISPONIBLE';
  END IF;

  -- Cupos: total − vendidos − pendientes de pago recientes (checkout en curso, 30 min).
  SELECT COALESCE(SUM(cantidad), 0) INTO v_pendientes
    FROM evento_inscripciones
   WHERE evento_id = p_evento_id AND estado = 'pendiente_pago'
     AND created_at > NOW() - INTERVAL '30 minutes';
  IF v_e.cupos_total - v_e.cupos_vendidos - v_pendientes < p_cantidad THEN
    RAISE EXCEPTION 'EVENTO_SIN_CUPOS';
  END IF;

  -- Monto SERVER-side — el front jamás manda el precio.
  v_monto := v_e.precio_por_persona * p_cantidad;

  INSERT INTO evento_inscripciones (
    tenant_id, local_id, evento_id, nombre, telefono, email, cantidad,
    monto_total, estado, idempotency_key
  ) VALUES (
    v_e.tenant_id, v_e.local_id, p_evento_id, trim(p_nombre),
    NULLIF(trim(COALESCE(p_telefono,'')),''), trim(p_email), p_cantidad,
    v_monto, 'pendiente_pago', p_idempotency_key
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('inscripcion_id', v_id, 'monto_total', v_monto);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_giftcards_publicas(p_local_slug text)
RETURNS TABLE (id bigint, nombre text, descripcion text, foto_url text, precio numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT g.id, g.nombre, g.descripcion, g.foto_url, g.precio
    FROM giftcards g
    JOIN comanda_local_settings cls ON cls.slug = p_local_slug
    JOIN locales l ON l.id = cls.local_id AND l.tenant_id = g.tenant_id
   WHERE g.activa AND g.deleted_at IS NULL
     AND (g.local_id IS NULL OR g.local_id = cls.local_id)
   ORDER BY g.precio;
$$;

CREATE OR REPLACE FUNCTION public.fn_comprar_giftcard_publica(
  p_local_slug text,
  p_giftcard_id bigint,
  p_comprador_nombre text,
  p_comprador_email text,
  p_comprador_telefono text DEFAULT NULL,
  p_para_nombre text DEFAULT NULL,
  p_mensaje text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_g giftcards%ROWTYPE;
  v_local integer;
  v_id bigint;
BEGIN
  IF p_comprador_nombre IS NULL OR trim(p_comprador_nombre) = '' THEN RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;
  IF p_comprador_email IS NULL OR trim(p_comprador_email) = '' THEN RAISE EXCEPTION 'EMAIL_REQUERIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_id FROM giftcard_compras
     WHERE giftcard_id = p_giftcard_id AND idempotency_key = p_idempotency_key;
    IF v_id IS NOT NULL THEN
      RETURN (SELECT jsonb_build_object('compra_id', id, 'monto', monto) FROM giftcard_compras WHERE id = v_id);
    END IF;
  END IF;

  SELECT cls.local_id INTO v_local FROM comanda_local_settings cls WHERE cls.slug = p_local_slug;
  IF v_local IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  SELECT g.* INTO v_g FROM giftcards g
    JOIN locales l ON l.id = v_local AND l.tenant_id = g.tenant_id
   WHERE g.id = p_giftcard_id AND g.activa AND g.deleted_at IS NULL
     AND (g.local_id IS NULL OR g.local_id = v_local);
  IF v_g.id IS NULL THEN RAISE EXCEPTION 'GIFTCARD_NO_DISPONIBLE'; END IF;

  INSERT INTO giftcard_compras (
    tenant_id, local_id, giftcard_id, comprador_nombre, comprador_email,
    comprador_telefono, para_nombre, mensaje, monto, estado, idempotency_key
  ) VALUES (
    v_g.tenant_id, v_local, p_giftcard_id, trim(p_comprador_nombre),
    trim(p_comprador_email), NULLIF(trim(COALESCE(p_comprador_telefono,'')),''),
    NULLIF(trim(COALESCE(p_para_nombre,'')),''), NULLIF(trim(COALESCE(p_mensaje,'')),''),
    v_g.precio, 'pendiente_pago', p_idempotency_key
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('compra_id', v_id, 'monto', v_g.precio);
END;
$$;

-- ─── Confirmación de pago (SOLO el webhook con service_role) ────────────────
CREATE OR REPLACE FUNCTION public.fn_confirmar_pago_evento(
  p_inscripcion_id bigint, p_payment_id text, p_monto numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_i evento_inscripciones%ROWTYPE;
BEGIN
  SELECT * INTO v_i FROM evento_inscripciones WHERE id = p_inscripcion_id FOR UPDATE;
  IF v_i.id IS NULL THEN RAISE EXCEPTION 'INSCRIPCION_NO_ENCONTRADA'; END IF;
  -- Idempotente: si ya está pagada con este payment, ok silencioso.
  IF v_i.estado = 'pagada' THEN
    RETURN jsonb_build_object('ok', true, 'ya_pagada', true);
  END IF;
  IF v_i.estado != 'pendiente_pago' THEN RAISE EXCEPTION 'INSCRIPCION_NO_PENDIENTE'; END IF;
  IF abs(COALESCE(p_monto,0) - v_i.monto_total) > 1 THEN RAISE EXCEPTION 'MONTO_NO_COINCIDE'; END IF;

  UPDATE evento_inscripciones
     SET estado = 'pagada', mp_payment_id = p_payment_id, pagada_at = NOW(), updated_at = NOW()
   WHERE id = p_inscripcion_id;

  UPDATE eventos
     SET cupos_vendidos = cupos_vendidos + v_i.cantidad,
         estado = CASE WHEN cupos_vendidos + v_i.cantidad >= cupos_total THEN 'agotado' ELSE estado END,
         updated_at = NOW()
   WHERE id = v_i.evento_id;

  RETURN jsonb_build_object('ok', true, 'inscripcion_id', p_inscripcion_id);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_confirmar_pago_evento(bigint, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirmar_pago_evento(bigint, text, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_confirmar_pago_giftcard(
  p_compra_id bigint, p_payment_id text, p_monto numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_c giftcard_compras%ROWTYPE;
  v_codigo text;
BEGIN
  SELECT * INTO v_c FROM giftcard_compras WHERE id = p_compra_id FOR UPDATE;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'COMPRA_NO_ENCONTRADA'; END IF;
  IF v_c.estado IN ('pagada','canjeada') THEN
    RETURN jsonb_build_object('ok', true, 'ya_pagada', true, 'codigo', v_c.codigo);
  END IF;
  IF v_c.estado != 'pendiente_pago' THEN RAISE EXCEPTION 'COMPRA_NO_PENDIENTE'; END IF;
  IF abs(COALESCE(p_monto,0) - v_c.monto) > 1 THEN RAISE EXCEPTION 'MONTO_NO_COINCIDE'; END IF;

  -- Código único legible (GC-XXXXXXXX). Reintenta si colisiona.
  LOOP
    v_codigo := 'GC-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM giftcard_compras WHERE codigo = v_codigo);
  END LOOP;

  UPDATE giftcard_compras
     SET estado = 'pagada', codigo = v_codigo, mp_payment_id = p_payment_id,
         pagada_at = NOW(), updated_at = NOW()
   WHERE id = p_compra_id;

  RETURN jsonb_build_object('ok', true, 'compra_id', p_compra_id, 'codigo', v_codigo);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_confirmar_pago_giftcard(bigint, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirmar_pago_giftcard(bigint, text, numeric) TO service_role;

-- ─── Canje en el POS (staff autenticado) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_canjear_giftcard(
  p_codigo text, p_venta_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_c giftcard_compras%ROWTYPE;
  v_g giftcards%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT * INTO v_c FROM giftcard_compras
   WHERE codigo = upper(trim(p_codigo)) AND tenant_id = v_tenant
   FOR UPDATE;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'GIFTCARD_CODIGO_INVALIDO'; END IF;
  IF v_c.estado = 'canjeada' THEN RAISE EXCEPTION 'GIFTCARD_YA_CANJEADA'; END IF;
  IF v_c.estado != 'pagada' THEN RAISE EXCEPTION 'GIFTCARD_NO_PAGADA'; END IF;

  SELECT * INTO v_g FROM giftcards WHERE id = v_c.giftcard_id;
  -- Si la giftcard es de UN local específico, el canje debe ser en un local visible.
  IF v_g.local_id IS NOT NULL AND NOT (auth_es_dueno_o_admin() OR v_g.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  UPDATE giftcard_compras
     SET estado = 'canjeada', canjeada_at = NOW(), canjeada_venta_id = p_venta_id, updated_at = NOW()
   WHERE id = v_c.id;

  RETURN jsonb_build_object(
    'ok', true, 'giftcard', v_g.nombre, 'monto', v_c.monto,
    'comprador', v_c.comprador_nombre, 'para', v_c.para_nombre, 'mensaje', v_c.mensaje
  );
END;
$$;
