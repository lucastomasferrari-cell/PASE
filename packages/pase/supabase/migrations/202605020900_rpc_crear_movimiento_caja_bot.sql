-- ═══════════════════════════════════════════════════════════════════════════
-- crear_movimiento_caja_bot: variante bot-friendly de crear_movimiento_caja
-- para ser invocada desde service_role (api/telegram-webhook.js).
--
-- Por qué hace falta una variante:
--   La RPC original crear_movimiento_caja (202604281206_rpcs_hardening_tenant.sql:140)
--   llama a _validar_local_autorizado, que evalúa auth_es_dueno_o_admin() y
--   auth_locales_visibles(). Ambas dependen de auth.uid() leído del JWT del
--   request. El bot de Telegram corre con SUPABASE_SERVICE_KEY, que no tiene
--   JWT de Supabase Auth → auth.uid() = NULL → todas las validaciones fallan
--   con LOCAL_NO_AUTORIZADO aunque el usuario sea dueño.
--
-- Diferencias respecto a crear_movimiento_caja:
--   1. Recibe p_usuario_id explícito (lo resuelve el bot desde
--      TELEGRAM_CHAT_USERS env var antes de llamar).
--   2. Valida usuario contra la tabla usuarios (id, activo, tenant_id, rol)
--      en lugar de auth.uid().
--   3. Valida cross-tenant: el local debe pertenecer al tenant del usuario.
--   4. Valida autorización del local: dueno/admin acceden a todos los locales
--      del tenant; encargado solo a los listados en usuario_locales.
--   5. SECURITY DEFINER para que la lógica corra independiente del rol que
--      llame, y el GRANT EXECUTE solo a service_role asegura que solo el bot
--      la pueda invocar (no anon, no authenticated).
--   6. El payload de auditoría incluye 'origen=telegram_bot' y el usuario_id
--      explícito (en vez de auth_usuario_id()).
--
-- Si en el futuro se agrega usuarios.telegram_chat_id, esta RPC sigue siendo
-- útil — el bot solo cambia la fuente del usuario_id (env var → DB lookup).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crear_movimiento_caja_bot(
  p_fecha       date,
  p_cuenta      text,
  p_tipo        text,
  p_cat         text,
  p_importe     numeric,         -- signed: positivo ingreso, negativo egreso
  p_detalle     text,
  p_local_id    integer,
  p_usuario_id  integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov_id          text;
  v_usuario         RECORD;
  v_tenant_local    uuid;
  v_es_dueno_admin  boolean;
  v_local_ok        boolean;
BEGIN
  -- ─── Validaciones de input ──────────────────────────────────────────────
  IF p_importe IS NULL OR p_importe = 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_tipo IS NULL OR p_tipo = ''     THEN RAISE EXCEPTION 'TIPO_INVALIDO';    END IF;
  IF p_local_id IS NULL                THEN RAISE EXCEPTION 'LOCAL_REQUERIDO';  END IF;
  IF p_usuario_id IS NULL              THEN RAISE EXCEPTION 'USUARIO_REQUERIDO';END IF;

  -- ─── Resolver usuario y validar estado ──────────────────────────────────
  SELECT id, tenant_id, activo, rol
    INTO v_usuario
  FROM usuarios
  WHERE id = p_usuario_id;

  IF NOT FOUND                       THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;
  IF NOT v_usuario.activo            THEN RAISE EXCEPTION 'USUARIO_INACTIVO';      END IF;
  IF v_usuario.tenant_id IS NULL     THEN RAISE EXCEPTION 'USUARIO_SIN_TENANT';    END IF;

  v_es_dueno_admin := v_usuario.rol IN ('dueno','admin');

  -- ─── Resolver tenant del local + validar pertenencia ────────────────────
  SELECT tenant_id INTO v_tenant_local FROM locales WHERE id = p_local_id;
  IF v_tenant_local IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;
  IF v_tenant_local <> v_usuario.tenant_id THEN
    RAISE EXCEPTION 'LOCAL_CROSS_TENANT';
  END IF;

  -- ─── Validar autorización del local (encargado restringido) ─────────────
  IF NOT v_es_dueno_admin THEN
    SELECT EXISTS (
      SELECT 1 FROM usuario_locales
      WHERE usuario_id = p_usuario_id AND local_id = p_local_id
    ) INTO v_local_ok;
    IF NOT v_local_ok THEN RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO'; END IF;
  END IF;

  -- ─── Insert atómico (idéntico a crear_movimiento_caja) ──────────────────
  PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, p_importe);

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, tenant_id)
  VALUES (v_mov_id, p_fecha, p_cuenta, p_tipo, p_cat, p_importe, p_detalle, p_local_id, v_tenant_local);

  PERFORM _auditar('movimientos', 'CREAR', jsonb_build_object(
    'mov_id',     v_mov_id,
    'importe',    p_importe,
    'cuenta',     p_cuenta,
    'local_id',   p_local_id,
    'usuario_id', p_usuario_id,
    'origen',     'telegram_bot'
  ), v_tenant_local);

  RETURN jsonb_build_object('mov_id', v_mov_id, 'tenant_id', v_tenant_local);
END;
$$;

-- Solo service_role puede invocar esta RPC. PUBLIC/anon/authenticated no.
REVOKE ALL ON FUNCTION crear_movimiento_caja_bot(
  date, text, text, text, numeric, text, integer, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION crear_movimiento_caja_bot(
  date, text, text, text, numeric, text, integer, integer
) TO service_role;
