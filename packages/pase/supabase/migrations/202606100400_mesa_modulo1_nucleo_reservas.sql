-- ════════════════════════════════════════════════════════════════════════
-- MESA · Módulo #1 — Núcleo de reservas + agenda interna (09-jun-2026).
-- Plan: docs/superpowers/plans/2026-06-09-mesa-modulo-1-nucleo-reservas.md
--
-- 1) fn_crear_reserva  — alta MANUAL por el staff (la pública ya existía).
-- 2) fn_editar_reserva — solo en pendiente/confirmada.
-- 3) fn_cambiar_estado_reserva — reescrita con MÁQUINA DE ESTADOS estricta
--    (antes permitía cualquier transición: cancelada→confirmada, etc.) +
--    p_mesa_id opcional al sentar (cumplida).
--
-- Máquina de estados (decisión fijada en el plan):
--   pendiente  → confirmada | cumplida (walk-in directo) | cancelada
--   confirmada → cumplida | no_show | cancelada
--   cumplida / no_show / cancelada → TERMINALES
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1) Alta manual ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_crear_reserva(
  p_local_id integer,
  p_cliente_nombre text,
  p_cliente_telefono text DEFAULT NULL,
  p_cliente_email text DEFAULT NULL,
  p_fecha_hora timestamptz DEFAULT NULL,
  p_personas integer DEFAULT 2,
  p_notas text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_id bigint;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;

  IF p_cliente_nombre IS NULL OR trim(p_cliente_nombre) = '' THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;
  IF p_fecha_hora IS NULL THEN RAISE EXCEPTION 'FECHA_REQUERIDA'; END IF;
  -- Tolerancia de 1h hacia atrás: el host puede cargar al que "recién llegó".
  IF p_fecha_hora < NOW() - INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'FECHA_PASADA';
  END IF;
  IF p_personas IS NULL OR p_personas < 1 OR p_personas > 50 THEN
    RAISE EXCEPTION 'PERSONAS_INVALIDAS';
  END IF;

  -- Idempotency (índice único parcial (local_id, idempotency_key)).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_id FROM reservas
     WHERE local_id = p_local_id AND idempotency_key = p_idempotency_key AND deleted_at IS NULL;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  INSERT INTO reservas (
    tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
    fecha_hora, personas, notas, estado, idempotency_key
  ) VALUES (
    v_tenant, p_local_id, trim(p_cliente_nombre),
    NULLIF(trim(COALESCE(p_cliente_telefono, '')), ''),
    NULLIF(trim(COALESCE(p_cliente_email, '')), ''),
    p_fecha_hora, p_personas, NULLIF(trim(COALESCE(p_notas, '')), ''),
    'pendiente', p_idempotency_key
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ─── 2) Edición (solo pre-terminales) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_editar_reserva(
  p_reserva_id bigint,
  p_cliente_nombre text DEFAULT NULL,
  p_cliente_telefono text DEFAULT NULL,
  p_cliente_email text DEFAULT NULL,
  p_fecha_hora timestamptz DEFAULT NULL,
  p_personas integer DEFAULT NULL,
  p_notas text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_r reservas%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF v_r.estado NOT IN ('pendiente', 'confirmada') THEN
    RAISE EXCEPTION 'RESERVA_NO_EDITABLE';
  END IF;

  IF p_cliente_nombre IS NOT NULL AND trim(p_cliente_nombre) = '' THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO';
  END IF;
  IF p_personas IS NOT NULL AND (p_personas < 1 OR p_personas > 50) THEN
    RAISE EXCEPTION 'PERSONAS_INVALIDAS';
  END IF;
  IF p_fecha_hora IS NOT NULL AND p_fecha_hora < NOW() - INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'FECHA_PASADA';
  END IF;

  UPDATE reservas SET
    cliente_nombre   = COALESCE(NULLIF(trim(COALESCE(p_cliente_nombre, '')), ''), cliente_nombre),
    cliente_telefono = CASE WHEN p_cliente_telefono IS NULL THEN cliente_telefono
                            ELSE NULLIF(trim(p_cliente_telefono), '') END,
    cliente_email    = CASE WHEN p_cliente_email IS NULL THEN cliente_email
                            ELSE NULLIF(trim(p_cliente_email), '') END,
    fecha_hora = COALESCE(p_fecha_hora, fecha_hora),
    personas   = COALESCE(p_personas, personas),
    notas      = CASE WHEN p_notas IS NULL THEN notas ELSE NULLIF(trim(p_notas), '') END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$$;

-- ─── 3) Máquina de estados estricta + sentar con mesa opcional ──────────────
-- Se dropea la firma vieja (3 args) para no dejar overload ambiguo.
DROP FUNCTION IF EXISTS public.fn_cambiar_estado_reserva(bigint, text, text);

CREATE OR REPLACE FUNCTION public.fn_cambiar_estado_reserva(
  p_reserva_id bigint,
  p_nuevo_estado text,
  p_motivo text DEFAULT NULL,
  p_mesa_id bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_r reservas%ROWTYPE;
  v_local_mesa integer;
  v_permitidas text[];
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_nuevo_estado NOT IN ('confirmada', 'cumplida', 'no_show', 'cancelada') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO';
  END IF;

  -- Máquina de estados (plan módulo #1):
  --   pendiente  → confirmada | cumplida (walk-in) | cancelada
  --   confirmada → cumplida | no_show | cancelada
  --   terminales → nada
  v_permitidas := CASE v_r.estado
    WHEN 'pendiente'  THEN ARRAY['confirmada', 'cumplida', 'cancelada']
    WHEN 'confirmada' THEN ARRAY['cumplida', 'no_show', 'cancelada']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (p_nuevo_estado = ANY(v_permitidas)) THEN
    RAISE EXCEPTION 'RESERVA_TRANSICION_INVALIDA: % → %', v_r.estado, p_nuevo_estado;
  END IF;

  -- Sentar con mesa opcional (solo aplica al pasar a cumplida).
  IF p_mesa_id IS NOT NULL THEN
    IF p_nuevo_estado != 'cumplida' THEN
      RAISE EXCEPTION 'MESA_SOLO_AL_SENTAR';
    END IF;
    SELECT local_id INTO v_local_mesa FROM mesas WHERE id = p_mesa_id AND deleted_at IS NULL;
    IF v_local_mesa IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
    IF v_local_mesa != v_r.local_id THEN RAISE EXCEPTION 'MESA_OTRO_LOCAL'; END IF;
  END IF;

  UPDATE reservas SET
    estado = p_nuevo_estado,
    mesa_id = COALESCE(p_mesa_id, mesa_id),
    confirmada_at = CASE WHEN p_nuevo_estado = 'confirmada' THEN NOW() ELSE confirmada_at END,
    cumplida_at   = CASE WHEN p_nuevo_estado = 'cumplida'   THEN NOW() ELSE cumplida_at END,
    cancelada_at  = CASE WHEN p_nuevo_estado = 'cancelada'  THEN NOW() ELSE cancelada_at END,
    motivo_cancelacion = CASE WHEN p_nuevo_estado = 'cancelada' THEN NULLIF(trim(COALESCE(p_motivo, '')), '') ELSE motivo_cancelacion END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$$;
