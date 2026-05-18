-- ═══════════════════════════════════════════════════════════════════════════
-- Manager Override TOTP — códigos rotativos para autorizar acciones de empleados
-- Sesión 2026-05-18
--
-- Lucas: "quiero crear una especie de Google autenticador pero para que los
-- empleados cuando quieran hacer algo que no tienen autorización me pidan un
-- código y yo se los doy pero que sea siempre distinto y yo además tener mi
-- password fijo".
--
-- Modelo:
--   - Cada tenant tiene UN secret TOTP de 20 bytes (random). Solo dueño lo ve.
--   - El secret genera códigos de 6 dígitos que rotan cada 30s (RFC 6238).
--   - Cuando un encargado intenta una acción gated, el frontend muestra modal
--     "pedí código al dueño". El encargado lo tipea, el frontend lo valida
--     via RPC validar_manager_override.
--   - Auditoría completa: cada uso queda registrado con accion/contexto.
--
-- Implementación TOTP en pgsql:
--   - HMAC-SHA1 via pgcrypto.hmac()
--   - Counter = floor(unix_time / 30), serializado a 8 bytes big-endian
--   - Truncate dinámico (RFC 4226 sec 5.3): offset = HMAC[19] & 15
--   - 6 dígitos: truncated % 1_000_000, padded con ceros
--
-- Ventana de tolerancia:
--   - Validamos con time_step actual ±1 (cubre ~60s de tolerancia, suficiente
--     para que el dueño dicte y el encargado tipee)
--
-- Anti-reuse:
--   - Tabla manager_override_usos con UNIQUE(tenant_id, time_step) — el mismo
--     time_step no se puede usar 2 veces. Garantiza 1-use real.
-- ═══════════════════════════════════════════════════════════════════════════

-- pgcrypto puede ya estar habilitado pero por las dudas:
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Tabla: secret TOTP por tenant ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_totp_secret (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  secret      BYTEA NOT NULL,  -- 20 bytes random
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INTEGER NULL REFERENCES usuarios(id),
  CONSTRAINT secret_length CHECK (octet_length(secret) = 20)
);

CREATE TRIGGER trg_tenant_totp_set_updated_at
  BEFORE UPDATE ON tenant_totp_secret
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE tenant_totp_secret ENABLE ROW LEVEL SECURITY;

-- NO policy para authenticated. Solo service_role + las RPCs SECURITY DEFINER
-- pueden leer/escribir. Si una RPC necesita el secret, lo hace internamente.
DROP POLICY IF EXISTS totp_secret_service ON tenant_totp_secret;
CREATE POLICY totp_secret_service ON tenant_totp_secret FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE tenant_totp_secret IS
  'Secret TOTP (20 bytes random) por tenant. Solo accesible via RPCs SECURITY DEFINER. Sesión 2026-05-18.';

-- ─── Tabla: auditoría de usos + anti-reuse ─────────────────────────────────
CREATE TABLE IF NOT EXISTS manager_override_usos (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),  -- quién usó el código
  accion      TEXT NOT NULL,   -- "anular_factura", "anular_movimiento", etc
  context     JSONB NULL,      -- info adicional: { factura_id, monto, motivo }
  time_step   BIGINT NOT NULL, -- floor(unix_time / 30) del código usado
  usado_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_time_step_por_tenant UNIQUE (tenant_id, time_step)
);

CREATE INDEX IF NOT EXISTS idx_override_usos_tenant_recent
  ON manager_override_usos(tenant_id, usado_at DESC);

ALTER TABLE manager_override_usos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS override_usos_select ON manager_override_usos;
CREATE POLICY override_usos_select ON manager_override_usos FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS override_usos_service ON manager_override_usos;
CREATE POLICY override_usos_service ON manager_override_usos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE manager_override_usos IS
  'Auditoría de cada vez que se usa un código de manager override. UNIQUE(tenant_id, time_step) garantiza 1-use real (mismo código no se puede usar 2 veces).';

-- ─── Helper interno: calcular TOTP de 6 dígitos ────────────────────────────
-- RFC 6238 + RFC 4226 (HOTP truncation dinámico)
CREATE OR REPLACE FUNCTION fn_calcular_totp(p_secret BYTEA, p_time_step BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_counter BYTEA;
  v_hmac BYTEA;
  v_offset INT;
  v_truncated BIGINT;
BEGIN
  -- Counter = p_time_step serializado a 8 bytes big-endian.
  -- p_time_step actual (~1.8e9) usa ~31 bits, los 4 bytes altos son 0.
  v_counter := decode('0000000000000000', 'hex');
  v_counter := set_byte(v_counter, 4, ((p_time_step >> 24) & 255)::INT);
  v_counter := set_byte(v_counter, 5, ((p_time_step >> 16) & 255)::INT);
  v_counter := set_byte(v_counter, 6, ((p_time_step >> 8) & 255)::INT);
  v_counter := set_byte(v_counter, 7, (p_time_step & 255)::INT);

  v_hmac := hmac(v_counter, p_secret, 'sha1');

  -- Truncate dinámico: offset = low nibble del último byte (byte 19)
  v_offset := get_byte(v_hmac, 19) & 15;

  -- Tomar 4 bytes desde offset, con high bit del primero a 0
  v_truncated :=
    ((get_byte(v_hmac, v_offset) & 127)::BIGINT << 24) |
    (get_byte(v_hmac, v_offset + 1)::BIGINT << 16) |
    (get_byte(v_hmac, v_offset + 2)::BIGINT << 8) |
    (get_byte(v_hmac, v_offset + 3)::BIGINT);

  RETURN LPAD((v_truncated % 1000000)::TEXT, 6, '0');
END;
$$;

COMMENT ON FUNCTION fn_calcular_totp(BYTEA, BIGINT) IS
  'Calcula código TOTP de 6 dígitos para un secret + time-step dado. Implementa RFC 6238 (HOTP-based, HMAC-SHA1, truncate dinámico).';

-- ─── RPC: generar o regenerar el secret TOTP del tenant ────────────────────
-- Solo dueño/admin. Si ya existe, lo regenera (operación destructiva — los
-- códigos que estén en mano dejan de andar).
CREATE OR REPLACE FUNCTION generar_tenant_totp_secret()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id INTEGER := auth_usuario_id();
  v_tenant UUID := auth_tenant_id();
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AUTH_SIN_TENANT';
  END IF;
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede generar secret TOTP';
  END IF;

  INSERT INTO tenant_totp_secret (tenant_id, secret, created_by)
  VALUES (v_tenant, gen_random_bytes(20), v_caller_id)
  ON CONFLICT (tenant_id) DO UPDATE
    SET secret = gen_random_bytes(20),
        updated_at = NOW(),
        created_by = v_caller_id;
END;
$$;

REVOKE ALL ON FUNCTION generar_tenant_totp_secret() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generar_tenant_totp_secret() TO authenticated;

-- ─── RPC: obtener el código TOTP actual (para que el dueño lo vea) ─────────
-- Devuelve el código del time-step actual + segundos restantes hasta el
-- próximo. Solo dueño/admin. Si no existe secret, lo crea automáticamente.
CREATE OR REPLACE FUNCTION obtener_codigo_totp_actual()
RETURNS TABLE(codigo TEXT, segundos_restantes INT, time_step BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := auth_tenant_id();
  v_secret BYTEA;
  v_now BIGINT := extract(epoch FROM NOW())::BIGINT;
  v_step BIGINT;
BEGIN
  IF auth_usuario_id() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AUTH_SIN_TENANT';
  END IF;
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: solo dueño/admin puede ver códigos TOTP';
  END IF;

  -- Lazy-init: si no existe secret, lo creamos.
  SELECT s.secret INTO v_secret FROM tenant_totp_secret s WHERE s.tenant_id = v_tenant;
  IF v_secret IS NULL THEN
    INSERT INTO tenant_totp_secret (tenant_id, secret, created_by)
    VALUES (v_tenant, gen_random_bytes(20), auth_usuario_id())
    RETURNING tenant_totp_secret.secret INTO v_secret;
  END IF;

  v_step := v_now / 30;

  RETURN QUERY SELECT
    fn_calcular_totp(v_secret, v_step),
    (30 - (v_now % 30))::INT,
    v_step;
END;
$$;

REVOKE ALL ON FUNCTION obtener_codigo_totp_actual() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION obtener_codigo_totp_actual() TO authenticated;

-- ─── RPC: pre-chequear que el código es válido (sin consumirlo) ────────────
-- El frontend usa esta RPC para validar el código en el modal ANTES de
-- llamar a la RPC final (anular_factura/etc). Si OK, el modal cierra y el
-- caller llama a la RPC final pasándole el mismo código. La RPC final
-- consume el código vía auth_tiene_permiso_o_override.
--
-- Importante: esta RPC NO consume. Si dos empleados validan el mismo código
-- en paralelo, ambos van a pasar acá — pero solo el primero en ejecutar la
-- acción real (la RPC final) gana. El otro recibe error.
CREATE OR REPLACE FUNCTION precheck_manager_override(
  p_codigo TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := auth_tenant_id();
  v_secret BYTEA;
  v_now BIGINT := extract(epoch FROM NOW())::BIGINT;
  v_step BIGINT := v_now / 30;
  v_matched_step BIGINT := NULL;
  v_offset INT;
BEGIN
  IF auth_usuario_id() IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AUTH_SIN_TENANT';
  END IF;
  IF p_codigo IS NULL OR length(p_codigo) <> 6 OR p_codigo !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'CODIGO_INVALIDO';
  END IF;

  SELECT s.secret INTO v_secret FROM tenant_totp_secret s WHERE s.tenant_id = v_tenant;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'TOTP_NO_INICIALIZADO';
  END IF;

  FOR v_offset IN -1..1 LOOP
    IF fn_calcular_totp(v_secret, v_step + v_offset) = p_codigo THEN
      v_matched_step := v_step + v_offset;
      EXIT;
    END IF;
  END LOOP;

  IF v_matched_step IS NULL THEN
    RAISE EXCEPTION 'CODIGO_NO_VALIDO';
  END IF;

  -- Chequeamos también si ya se consumió en otra acción (no consumimos acá,
  -- solo informamos). Si ya se usó, el modal puede mostrar error claro.
  IF EXISTS (SELECT 1 FROM manager_override_usos WHERE tenant_id = v_tenant AND time_step = v_matched_step) THEN
    RAISE EXCEPTION 'CODIGO_YA_USADO';
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION precheck_manager_override(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION precheck_manager_override(TEXT) TO authenticated;

COMMENT ON FUNCTION precheck_manager_override(TEXT) IS
  'Valida si un código TOTP es correcto y no fue usado, SIN consumirlo. Usado por el frontend para feedback inmediato al usuario antes de ejecutar la acción final.';

-- ─── Helper: chequear permiso O override válido (para RPCs gated) ──────────
-- Las RPCs que requieren permiso especial (anular_factura, anular_gasto, etc.)
-- llaman a este helper en vez del clásico auth_tiene_permiso(). Si el caller
-- tiene el permiso, devuelve TRUE directo (sin tocar el código).  Si no,
-- valida el código TOTP (mismo flow que validar_manager_override pero sin
-- volver a RAISE — devuelve FALSE si el código es inválido).
--
-- IMPORTANTE: este helper SIEMPRE registra el uso del override en
-- manager_override_usos si el código fue válido — incluso si la operación
-- subsecuente falla por otro motivo. Auditoría completa.
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
BEGIN
  -- Si tiene el permiso, OK directo sin tocar override.
  IF auth_es_dueno_o_admin() OR auth_tiene_permiso(p_permiso) THEN
    RETURN TRUE;
  END IF;

  -- Sin permiso → buscar override válido.
  IF p_override_code IS NULL OR length(p_override_code) <> 6 OR p_override_code !~ '^[0-9]{6}$' THEN
    RETURN FALSE;
  END IF;
  IF v_caller_id IS NULL OR v_tenant IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT s.secret INTO v_secret FROM tenant_totp_secret s WHERE s.tenant_id = v_tenant;
  IF v_secret IS NULL THEN
    RETURN FALSE;
  END IF;

  FOR v_offset IN -1..1 LOOP
    IF fn_calcular_totp(v_secret, v_step + v_offset) = p_override_code THEN
      v_matched_step := v_step + v_offset;
      EXIT;
    END IF;
  END LOOP;

  IF v_matched_step IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Anti-reuse: si el step ya fue usado, falla la inserción → no podemos
  -- otorgar permiso (el código ya se gastó).
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
  'Helper para RPCs gated. Devuelve TRUE si el caller tiene el permiso, O si presenta un código TOTP válido + no-usado. Registra el uso del override en manager_override_usos.';

NOTIFY pgrst, 'reload schema';
