-- ═══════════════════════════════════════════════════════════════════════════
-- Reservas online
--
-- El cliente desde el marketplace o un link directo reserva una mesa para
-- fecha + hora + N personas. Validación server-side de capacidad.
--
-- Estados:
--   pendiente   → la cargó el cliente, pendiente confirmación del local
--   confirmada  → el local la aprobó
--   cumplida    → el cliente vino y consumió
--   no_show     → no apareció (afecta reputación)
--   cancelada   → el cliente o el local canceló
--
-- Diseño minimalista:
--   - NO se asignan mesas específicas en el momento de reservar — la asignación
--     concreta la hace el host al check-in según disponibilidad real.
--   - El número de personas y el horario son los que cuentan para validar
--     capacidad. Calculamos sumando todas las reservas confirmadas en una
--     ventana de tiempo.
--
-- Configuración por local en comanda_local_settings:
--   reservas_activas BOOLEAN
--   reservas_capacidad_max INTEGER (default = sum capacidad mesas)
--   reservas_anticipacion_min_hs (default 2)
--   reservas_anticipacion_max_dias (default 30)
--   reservas_duracion_estimada_min (default 90)
--   reservas_horarios (JSONB con franjas válidas por día)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Settings ──────────────────────────────────────────────────────────────
ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_activas BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reservas_capacidad_max INTEGER,
  ADD COLUMN IF NOT EXISTS reservas_anticipacion_min_hs INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS reservas_anticipacion_max_dias INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reservas_duracion_estimada_min INTEGER DEFAULT 90,
  ADD COLUMN IF NOT EXISTS reservas_horarios JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reservas_telefono_obligatorio BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reservas_requiere_confirmacion BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reservas_notas_visibles_cliente TEXT;

COMMENT ON COLUMN comanda_local_settings.reservas_activas IS
  'Si TRUE, el local acepta reservas online. Default FALSE — opt-in.';
COMMENT ON COLUMN comanda_local_settings.reservas_capacidad_max IS
  'Capacidad total simultánea para reservas (suma personas). NULL = calcular desde mesas.';
COMMENT ON COLUMN comanda_local_settings.reservas_duracion_estimada_min IS
  'Cuántos minutos asumimos que dura una reserva al validar overlapping. Default 90.';
COMMENT ON COLUMN comanda_local_settings.reservas_horarios IS
  'JSONB array: [{dia: 0-6, abre: "20:00", cierra: "23:30"}]. Dia 0=Domingo.';
COMMENT ON COLUMN comanda_local_settings.reservas_requiere_confirmacion IS
  'Si TRUE, las reservas entran pendientes y el local las debe confirmar manualmente. Si FALSE, auto-confirma.';

-- ─── Tabla reservas ────────────────────────────────────────────────────────
-- Nota: había una tabla `reservas` vieja con schema distinto (fecha + hora_inicio).
-- Como nunca se usó (UI "Próximamente"), la dropeamos y recreamos limpia.
DROP TABLE IF EXISTS reservas CASCADE;

CREATE TABLE IF NOT EXISTS reservas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  local_id        INTEGER NOT NULL,
  -- Cliente
  cliente_nombre  TEXT NOT NULL,
  cliente_telefono TEXT,
  cliente_email   TEXT,
  cliente_id      BIGINT, -- FK opcional a tabla clientes
  -- Reserva
  fecha_hora      TIMESTAMPTZ NOT NULL,
  personas        INTEGER NOT NULL CHECK (personas > 0 AND personas <= 50),
  notas           TEXT,
  -- Estado
  estado          TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'confirmada', 'cumplida', 'no_show', 'cancelada')),
  motivo_cancelacion TEXT,
  cancelada_por_cliente BOOLEAN DEFAULT FALSE,
  -- Asignación de mesa al check-in (opcional)
  mesa_id         BIGINT,
  -- Audit
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  confirmada_at   TIMESTAMPTZ,
  cumplida_at     TIMESTAMPTZ,
  cancelada_at    TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  -- Idempotency key del cliente
  idempotency_key TEXT,

  -- (sin CHECK fecha_futura — created_at default no se evalúa antes del INSERT
  --  y validamos en la RPC. Inserts directos van a ir bien igual)
  CONSTRAINT check_fecha_no_pasado CHECK (fecha_hora IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_reservas_local_fecha
  ON reservas(local_id, fecha_hora) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reservas_tenant_estado
  ON reservas(tenant_id, estado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reservas_cliente_tel
  ON reservas(cliente_telefono) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_idempotency
  ON reservas(local_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE reservas ENABLE ROW LEVEL SECURITY;

CREATE POLICY reservas_all ON reservas
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- ─── Trigger updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_reservas_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS reservas_updated_at ON reservas;
CREATE TRIGGER reservas_updated_at
  BEFORE UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION trg_reservas_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs públicas (sin auth, vía dbAnon)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Get info reservas del local (config + horarios) ──────────────────────
CREATE OR REPLACE FUNCTION fn_get_reservas_info_publico(p_local_slug TEXT)
RETURNS TABLE (
  local_id INTEGER,
  local_nombre TEXT,
  activas BOOLEAN,
  capacidad_max INTEGER,
  anticipacion_min_hs INTEGER,
  anticipacion_max_dias INTEGER,
  duracion_estimada_min INTEGER,
  horarios JSONB,
  telefono_obligatorio BOOLEAN,
  notas_publicas TEXT,
  requiere_confirmacion BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    cls.local_id,
    l.nombre,
    cls.reservas_activas,
    COALESCE(cls.reservas_capacidad_max, 50),
    cls.reservas_anticipacion_min_hs,
    cls.reservas_anticipacion_max_dias,
    cls.reservas_duracion_estimada_min,
    COALESCE(cls.reservas_horarios, '[]'::jsonb),
    cls.reservas_telefono_obligatorio,
    cls.reservas_notas_visibles_cliente,
    cls.reservas_requiere_confirmacion
  FROM comanda_local_settings cls
  INNER JOIN locales l ON l.id = cls.local_id
  WHERE cls.slug = p_local_slug
    AND cls.tienda_activa = TRUE
    AND cls.deleted_at IS NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_get_reservas_info_publico(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_get_reservas_info_publico(TEXT) TO authenticated;

-- ─── Verificar disponibilidad ─────────────────────────────────────────────
--
-- Para una fecha+hora y N personas, ¿hay lugar? Suma reservas confirmadas
-- + pendientes en la ventana [fecha-duracion, fecha+duracion] y compara
-- con capacidad_max.
CREATE OR REPLACE FUNCTION fn_check_disponibilidad_reserva(
  p_local_slug TEXT,
  p_fecha_hora TIMESTAMPTZ,
  p_personas INTEGER
) RETURNS TABLE (
  disponible BOOLEAN,
  motivo TEXT,
  personas_actuales INTEGER,
  capacidad_max INTEGER
) LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE
  v_local_id INTEGER;
  v_activas BOOLEAN;
  v_capacidad INTEGER;
  v_duracion INTEGER;
  v_anticip_min INTEGER;
  v_anticip_max INTEGER;
  v_actuales INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT
    cls.local_id, cls.reservas_activas, COALESCE(cls.reservas_capacidad_max, 50),
    cls.reservas_duracion_estimada_min, cls.reservas_anticipacion_min_hs,
    cls.reservas_anticipacion_max_dias
  INTO v_local_id, v_activas, v_capacidad, v_duracion, v_anticip_min, v_anticip_max
  FROM comanda_local_settings cls
  WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;

  IF v_local_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'LOCAL_NO_ENCONTRADO', 0, 0; RETURN;
  END IF;
  IF NOT v_activas THEN
    RETURN QUERY SELECT FALSE, 'RESERVAS_DESACTIVADAS', 0, v_capacidad; RETURN;
  END IF;
  IF p_personas < 1 OR p_personas > 50 THEN
    RETURN QUERY SELECT FALSE, 'PERSONAS_INVALIDAS', 0, v_capacidad; RETURN;
  END IF;
  -- Validación anticipación
  IF p_fecha_hora < v_now + (v_anticip_min || ' hours')::INTERVAL THEN
    RETURN QUERY SELECT FALSE, 'ANTICIPACION_INSUFICIENTE', 0, v_capacidad; RETURN;
  END IF;
  IF p_fecha_hora > v_now + (v_anticip_max || ' days')::INTERVAL THEN
    RETURN QUERY SELECT FALSE, 'FECHA_DEMASIADO_LEJANA', 0, v_capacidad; RETURN;
  END IF;

  -- Sumar reservas activas en ventana ± duracion
  SELECT COALESCE(SUM(personas), 0) INTO v_actuales
  FROM reservas
  WHERE local_id = v_local_id
    AND estado IN ('pendiente', 'confirmada')
    AND deleted_at IS NULL
    AND fecha_hora BETWEEN
        p_fecha_hora - (v_duracion || ' minutes')::INTERVAL
        AND p_fecha_hora + (v_duracion || ' minutes')::INTERVAL;

  IF v_actuales + p_personas > v_capacidad THEN
    RETURN QUERY SELECT FALSE, 'SIN_CUPO', v_actuales, v_capacidad; RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'OK'::TEXT, v_actuales, v_capacidad;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_check_disponibilidad_reserva(TEXT, TIMESTAMPTZ, INTEGER) TO anon;
GRANT EXECUTE ON FUNCTION fn_check_disponibilidad_reserva(TEXT, TIMESTAMPTZ, INTEGER) TO authenticated;

-- ─── Crear reserva pública ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_crear_reserva_publica(
  p_local_slug TEXT,
  p_cliente_nombre TEXT,
  p_cliente_telefono TEXT,
  p_cliente_email TEXT,
  p_fecha_hora TIMESTAMPTZ,
  p_personas INTEGER,
  p_notas TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE (id BIGINT, estado TEXT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_disponible BOOLEAN;
  v_motivo TEXT;
  v_existing BIGINT;
  v_new_id BIGINT;
  v_requiere_confirm BOOLEAN;
  v_estado_inicial TEXT;
  v_tel_oblig BOOLEAN;
BEGIN
  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT r.id INTO v_existing FROM reservas r
    INNER JOIN comanda_local_settings cls ON cls.local_id = r.local_id
    WHERE cls.slug = p_local_slug AND r.idempotency_key = p_idempotency_key AND r.deleted_at IS NULL;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT v_existing, (SELECT r2.estado FROM reservas r2 WHERE r2.id = v_existing); RETURN;
    END IF;
  END IF;

  -- Validar disponibilidad (esto también valida local existe + activas + capacidad)
  SELECT d.disponible, d.motivo INTO v_disponible, v_motivo
  FROM fn_check_disponibilidad_reserva(p_local_slug, p_fecha_hora, p_personas) d;

  IF NOT v_disponible THEN
    RAISE EXCEPTION '%', v_motivo;
  END IF;

  -- Resolver tenant + local + settings extra
  SELECT cls.local_id, l.tenant_id, cls.reservas_requiere_confirmacion, cls.reservas_telefono_obligatorio
    INTO v_local_id, v_tenant_id, v_requiere_confirm, v_tel_oblig
    FROM comanda_local_settings cls
    INNER JOIN locales l ON l.id = cls.local_id
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;

  -- Validaciones extra
  IF v_tel_oblig AND (p_cliente_telefono IS NULL OR length(trim(p_cliente_telefono)) < 6) THEN
    RAISE EXCEPTION 'TELEFONO_REQUERIDO';
  END IF;
  IF p_cliente_nombre IS NULL OR length(trim(p_cliente_nombre)) < 2 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;

  v_estado_inicial := CASE WHEN v_requiere_confirm THEN 'pendiente' ELSE 'confirmada' END;

  INSERT INTO reservas (
    tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
    fecha_hora, personas, notas, estado, idempotency_key,
    confirmada_at
  ) VALUES (
    v_tenant_id, v_local_id, trim(p_cliente_nombre),
    NULLIF(trim(p_cliente_telefono), ''), NULLIF(trim(p_cliente_email), ''),
    p_fecha_hora, p_personas, NULLIF(trim(p_notas), ''), v_estado_inicial, p_idempotency_key,
    CASE WHEN v_estado_inicial = 'confirmada' THEN NOW() ELSE NULL END
  ) RETURNING reservas.id INTO v_new_id;

  -- Upsert cliente (mejor esfuerzo). Firma:
  --   (p_local_slug, p_telefono, p_nombre, p_email, p_direccion, p_direccion_aclaracion)
  IF p_cliente_telefono IS NOT NULL AND length(trim(p_cliente_telefono)) >= 6 THEN
    BEGIN
      PERFORM fn_upsert_cliente_publico_comanda(
        p_local_slug, trim(p_cliente_telefono), trim(p_cliente_nombre),
        NULLIF(trim(p_cliente_email), ''), NULL, NULL
      );
    EXCEPTION WHEN OTHERS THEN
      -- Best effort — no romper la reserva si falla el upsert cliente
      NULL;
    END;
  END IF;

  RETURN QUERY SELECT v_new_id, v_estado_inicial;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_crear_reserva_publica(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_crear_reserva_publica(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT) TO authenticated;

-- ─── Cancelar reserva (cliente o local) ───────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cancelar_reserva_publica(
  p_reserva_id BIGINT,
  p_telefono TEXT,
  p_motivo TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE reservas SET
    estado = 'cancelada',
    motivo_cancelacion = NULLIF(trim(p_motivo), ''),
    cancelada_por_cliente = TRUE,
    cancelada_at = NOW(),
    updated_at = NOW()
  WHERE id = p_reserva_id
    AND cliente_telefono = p_telefono
    AND estado IN ('pendiente', 'confirmada')
    AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_cancelar_reserva_publica(BIGINT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION fn_cancelar_reserva_publica(BIGINT, TEXT, TEXT) TO authenticated;

-- ─── Admin: cambiar estado reserva ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cambiar_estado_reserva(
  p_reserva_id BIGINT,
  p_nuevo_estado TEXT,
  p_motivo TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT local_id INTO v_local_id FROM reservas
  WHERE id = p_reserva_id AND tenant_id = v_tenant_id AND deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_nuevo_estado NOT IN ('confirmada','cumplida','no_show','cancelada') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO';
  END IF;

  UPDATE reservas SET
    estado = p_nuevo_estado,
    confirmada_at = CASE WHEN p_nuevo_estado = 'confirmada' THEN NOW() ELSE confirmada_at END,
    cumplida_at   = CASE WHEN p_nuevo_estado = 'cumplida'   THEN NOW() ELSE cumplida_at END,
    cancelada_at  = CASE WHEN p_nuevo_estado = 'cancelada'  THEN NOW() ELSE cancelada_at END,
    motivo_cancelacion = CASE WHEN p_nuevo_estado = 'cancelada' THEN NULLIF(trim(p_motivo),'') ELSE motivo_cancelacion END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_cambiar_estado_reserva(BIGINT, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
