-- ─────────────────────────────────────────────────────────────────────────
-- Sistema de SOLICITUDES de autorización (alternativa a códigos TOTP).
-- ─────────────────────────────────────────────────────────────────────────
--
-- Pedido Lucas 27-may noche: "en ves de pasar un codigo que me llege una
-- solicitud de anulacion creo que va a ser mas comodo que un codigo".
--
-- Flujo:
--   1. Empleado intenta acción gated (anular factura, descuento >15%, etc.)
--   2. El sistema detecta que NO tiene el permiso → ofrece 2 opciones:
--      a) Pedir autorización al dueño (recomendado).
--      b) Tipear código TOTP (fallback offline, sigue funcionando).
--   3. Si elige (a), `fn_solicitar_autorizacion` crea fila + inserta
--      notif en la cola → cron procesa → push al celu del dueño.
--   4. El dueño abre el push → cae en `/aprobar-solicitud/:id` → ve
--      detalle + botones Aprobar/Rechazar.
--   5. Al aprobar, se genera un `token` UUID de uso único.
--   6. El frontend del empleado (en polling) detecta la aprobación,
--      toma el token y lo manda a la RPC final (`anular_factura`,
--      etc.) como `p_override_code`.
--   7. La RPC valida el token via `auth_tiene_permiso_o_override` (que
--      ahora acepta TOTP o token de solicitud aprobada).
--
-- Por qué la misma columna `p_override_code` acepta ambos:
--   - TOTP son 6 dígitos numéricos.
--   - Token solicitud es UUID con guiones (36 chars con dashes).
--   - El helper distingue por formato sin ambigüedad.
--
-- Por qué expira a 15 min:
--   - Si el dueño no responde en 15 min, el empleado puede reintentar
--     con código TOTP o cancelar.
--   - Si responde después, el frontend ya no está esperando → la
--     solicitud queda en `expirada` (cron cleanup nightly opcional).
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Tabla ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manager_solicitudes (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  creada_por_usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  -- Slug de la acción (ej: "anular_factura", "descuento_pos", "merma_robo").
  -- Coincide con el segundo arg de `auth_tiene_permiso_o_override`.
  accion                   TEXT NOT NULL,
  -- Snapshot de los datos para mostrarle al dueño + para reconstruir la
  -- acción si hace falta. Ej: { factura_id, nro, total, proveedor, motivo, local_nombre }.
  context                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  estado                   TEXT NOT NULL DEFAULT 'pendiente'
                           CHECK (estado IN ('pendiente','aprobada','rechazada','expirada','usada')),
  aprobada_por_usuario_id  INTEGER NULL REFERENCES usuarios(id),
  aprobada_at              TIMESTAMPTZ NULL,
  rechazo_motivo           TEXT NULL,
  -- Token de uso único, generado al aprobar. UUID con dashes (36 chars),
  -- distinguible de un TOTP (6 dígitos).
  token                    TEXT NULL UNIQUE,
  usada_at                 TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '15 minutes')
);

CREATE INDEX IF NOT EXISTS idx_manager_solicitudes_tenant_estado
  ON manager_solicitudes (tenant_id, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manager_solicitudes_creador
  ON manager_solicitudes (creada_por_usuario_id, created_at DESC);

COMMENT ON TABLE manager_solicitudes IS
  'Solicitudes de autorización: empleado sin permiso pide al dueño autorizar '
  'una acción. Push al celu + pantalla /aprobar-solicitud/:id. Alternativa '
  'a códigos TOTP (que siguen funcionando como fallback).';

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE manager_solicitudes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_solicitudes_select ON manager_solicitudes;
CREATE POLICY manager_solicitudes_select ON manager_solicitudes
  FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR creada_por_usuario_id = auth_usuario_id()
    ))
  );

-- INSERT: cualquier user authenticated del tenant (el caller siempre es
-- el creada_por_usuario_id, validado en el RPC).
DROP POLICY IF EXISTS manager_solicitudes_insert ON manager_solicitudes;
CREATE POLICY manager_solicitudes_insert ON manager_solicitudes
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth_tenant_id());

-- UPDATE: solo dueño/admin (aprobar / rechazar) o el sistema vía SECURITY DEFINER.
DROP POLICY IF EXISTS manager_solicitudes_update ON manager_solicitudes;
CREATE POLICY manager_solicitudes_update ON manager_solicitudes
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());

-- ─── RPC: solicitar autorización ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_solicitar_autorizacion(
  p_accion TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := auth_tenant_id();
  v_caller_id INTEGER := auth_usuario_id();
  v_id BIGINT;
  v_caller_nombre TEXT;
BEGIN
  IF v_tenant IS NULL OR v_caller_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF p_accion IS NULL OR length(trim(p_accion)) = 0 THEN
    RAISE EXCEPTION 'ACCION_REQUERIDA';
  END IF;

  -- Anti-spam: bloquear si el caller ya tiene >5 pendientes en últimas 5 min.
  IF (
    SELECT COUNT(*) FROM manager_solicitudes
    WHERE creada_por_usuario_id = v_caller_id
      AND estado = 'pendiente'
      AND created_at > now() - INTERVAL '5 minutes'
  ) >= 5 THEN
    RAISE EXCEPTION 'DEMASIADAS_SOLICITUDES';
  END IF;

  INSERT INTO manager_solicitudes (tenant_id, creada_por_usuario_id, accion, context)
  VALUES (v_tenant, v_caller_id, p_accion, COALESCE(p_context, '{}'::jsonb))
  RETURNING id INTO v_id;

  -- Encolar push al dueño. La cola `notificaciones_pendientes` la consume
  -- el cron notif-pendientes-cron (cada 5 min).
  SELECT nombre INTO v_caller_nombre FROM usuarios WHERE id = v_caller_id;

  INSERT INTO notificaciones_pendientes (tenant_id, tipo, payload)
  VALUES (v_tenant, 'manager_solicitud_nueva', jsonb_build_object(
    'solicitud_id', v_id,
    'accion', p_accion,
    'creador_nombre', COALESCE(v_caller_nombre, 'Alguien'),
    'context', p_context
  ));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_solicitar_autorizacion(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_solicitar_autorizacion(TEXT, JSONB) TO authenticated;

-- ─── RPC: aprobar solicitud ─────────────────────────────────────────────
-- Genera un token UUID único que el frontend del empleado va a usar como
-- `p_override_code` en la acción final. El token se invalida al primer uso
-- (marca usada_at) — mismo patrón anti-replay que TOTP.
CREATE OR REPLACE FUNCTION fn_aprobar_solicitud(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_solicitud RECORD;
  v_token TEXT;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede aprobar';
  END IF;

  SELECT * INTO v_solicitud FROM manager_solicitudes WHERE id = p_id FOR UPDATE;
  IF v_solicitud IS NULL THEN
    RAISE EXCEPTION 'SOLICITUD_NO_ENCONTRADA';
  END IF;
  IF v_solicitud.tenant_id <> auth_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;
  IF v_solicitud.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'SOLICITUD_ESTADO_INVALIDO: %', v_solicitud.estado;
  END IF;
  IF v_solicitud.expires_at < now() THEN
    UPDATE manager_solicitudes SET estado = 'expirada' WHERE id = p_id;
    RAISE EXCEPTION 'SOLICITUD_EXPIRADA';
  END IF;

  v_token := gen_random_uuid()::TEXT;

  UPDATE manager_solicitudes
    SET estado = 'aprobada',
        aprobada_por_usuario_id = auth_usuario_id(),
        aprobada_at = now(),
        token = v_token
    WHERE id = p_id;

  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION fn_aprobar_solicitud(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_aprobar_solicitud(BIGINT) TO authenticated;

-- ─── RPC: rechazar solicitud ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_rechazar_solicitud(p_id BIGINT, p_motivo TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_solicitud RECORD;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede rechazar';
  END IF;

  SELECT * INTO v_solicitud FROM manager_solicitudes WHERE id = p_id FOR UPDATE;
  IF v_solicitud IS NULL THEN
    RAISE EXCEPTION 'SOLICITUD_NO_ENCONTRADA';
  END IF;
  IF v_solicitud.tenant_id <> auth_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;
  IF v_solicitud.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'SOLICITUD_ESTADO_INVALIDO: %', v_solicitud.estado;
  END IF;

  UPDATE manager_solicitudes
    SET estado = 'rechazada',
        aprobada_por_usuario_id = auth_usuario_id(),
        aprobada_at = now(),
        rechazo_motivo = p_motivo
    WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_rechazar_solicitud(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_rechazar_solicitud(BIGINT, TEXT) TO authenticated;

-- ─── RPC: polling para el empleado ──────────────────────────────────────
-- El frontend del empleado consulta cada N segundos para saber si la
-- solicitud fue aprobada. Si SÍ, devuelve el token (uso único) — el
-- empleado lo manda como p_override_code a la RPC final.
CREATE OR REPLACE FUNCTION fn_consultar_solicitud(p_id BIGINT)
RETURNS TABLE (
  estado TEXT,
  token TEXT,
  rechazo_motivo TEXT,
  aprobador_nombre TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id INTEGER := auth_usuario_id();
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  RETURN QUERY
    SELECT ms.estado, ms.token, ms.rechazo_motivo,
           (SELECT u.nombre FROM usuarios u WHERE u.id = ms.aprobada_por_usuario_id)
    FROM manager_solicitudes ms
    WHERE ms.id = p_id
      AND (ms.creada_por_usuario_id = v_caller_id OR auth_es_dueno_o_admin())
      AND ms.tenant_id = auth_tenant_id();
END;
$$;

REVOKE ALL ON FUNCTION fn_consultar_solicitud(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_consultar_solicitud(BIGINT) TO authenticated;

-- ─── RPC: listar pendientes (para el dueño) ─────────────────────────────
CREATE OR REPLACE FUNCTION fn_listar_solicitudes_pendientes()
RETURNS TABLE (
  id BIGINT,
  accion TEXT,
  context JSONB,
  creador_nombre TEXT,
  creador_id INTEGER,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin';
  END IF;

  RETURN QUERY
    SELECT ms.id, ms.accion, ms.context,
           (SELECT u.nombre FROM usuarios u WHERE u.id = ms.creada_por_usuario_id),
           ms.creada_por_usuario_id,
           ms.created_at, ms.expires_at
    FROM manager_solicitudes ms
    WHERE ms.tenant_id = auth_tenant_id()
      AND ms.estado = 'pendiente'
      AND ms.expires_at > now()
    ORDER BY ms.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION fn_listar_solicitudes_pendientes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_listar_solicitudes_pendientes() TO authenticated;

-- ─── EXTENDER `auth_tiene_permiso_o_override` para aceptar token ────────
-- El helper EXISTENTE acepta solo TOTP (6 dígitos). Lo extendemos para
-- también aceptar token UUID (36 chars con dashes). Mantiene compat con
-- todas las RPCs que ya lo usan — no cambia la firma.
CREATE OR REPLACE FUNCTION auth_tiene_permiso_o_override(
  p_permiso TEXT,
  p_override_code TEXT,
  p_accion TEXT,
  p_context JSONB DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id INTEGER := auth_usuario_id();
  v_tenant UUID := auth_tenant_id();
  v_secret BYTEA;
  v_now BIGINT := extract(epoch FROM NOW())::BIGINT;
  v_step BIGINT := v_now / 30;
  v_matched_step BIGINT := NULL;
  v_offset INT;
  v_solicitud RECORD;
BEGIN
  -- Si tiene el permiso, OK directo sin tocar override.
  IF auth_es_dueno_o_admin() OR auth_tiene_permiso(p_permiso) THEN
    RETURN TRUE;
  END IF;

  -- Sin permiso → debe haber un override.
  IF p_override_code IS NULL OR length(p_override_code) = 0 THEN
    RETURN FALSE;
  END IF;
  IF v_caller_id IS NULL OR v_tenant IS NULL THEN
    RETURN FALSE;
  END IF;

  -- ─── CASO 1: token UUID de solicitud aprobada (sprint 27-may) ───────
  -- Formato: 36 chars con guiones, ej '550e8400-e29b-41d4-a716-446655440000'.
  IF length(p_override_code) = 36 AND p_override_code ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    SELECT * INTO v_solicitud
    FROM manager_solicitudes
    WHERE token = p_override_code AND tenant_id = v_tenant
    FOR UPDATE;
    IF v_solicitud IS NULL THEN RETURN FALSE; END IF;
    IF v_solicitud.estado <> 'aprobada' THEN RETURN FALSE; END IF;
    IF v_solicitud.usada_at IS NOT NULL THEN RETURN FALSE; END IF;
    IF v_solicitud.expires_at < now() THEN RETURN FALSE; END IF;
    -- El empleado que pidió debe ser el que consume.
    IF v_solicitud.creada_por_usuario_id <> v_caller_id THEN RETURN FALSE; END IF;
    -- Validar que la acción coincide con la solicitada (defense-in-depth:
    -- evita que un token aprobado para anular_factura se reuse para mermas).
    IF v_solicitud.accion IS DISTINCT FROM p_accion THEN RETURN FALSE; END IF;

    -- Consumir token (uso único).
    UPDATE manager_solicitudes
      SET estado = 'usada', usada_at = now()
      WHERE id = v_solicitud.id;

    RETURN TRUE;
  END IF;

  -- ─── CASO 2: TOTP de 6 dígitos (flow viejo, sigue funcionando) ──────
  IF length(p_override_code) <> 6 OR p_override_code !~ '^[0-9]{6}$' THEN
    RETURN FALSE;
  END IF;

  SELECT s.secret INTO v_secret FROM tenant_totp_secret s WHERE s.tenant_id = v_tenant;
  IF v_secret IS NULL THEN RETURN FALSE; END IF;

  FOR v_offset IN -1..1 LOOP
    IF fn_calcular_totp(v_secret, v_step + v_offset) = p_override_code THEN
      v_matched_step := v_step + v_offset;
      EXIT;
    END IF;
  END LOOP;
  IF v_matched_step IS NULL THEN RETURN FALSE; END IF;

  -- Anti-reuse del TOTP.
  BEGIN
    INSERT INTO manager_override_usos (tenant_id, usuario_id, accion, context, time_step)
    VALUES (v_tenant, v_caller_id, p_accion, p_context, v_matched_step);
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION auth_tiene_permiso_o_override(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_tiene_permiso_o_override(TEXT, TEXT, TEXT, JSONB) TO authenticated;

COMMENT ON FUNCTION auth_tiene_permiso_o_override(TEXT, TEXT, TEXT, JSONB) IS
  'Helper para RPCs gated. Acepta como override: (a) token UUID de '
  'solicitud aprobada (formato 8-4-4-4-12), o (b) código TOTP 6 dígitos. '
  'Ambos uso único.';

NOTIFY pgrst, 'reload schema';
