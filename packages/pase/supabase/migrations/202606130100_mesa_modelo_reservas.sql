-- ════════════════════════════════════════════════════════════════════════
-- MESA · Modelo de reservas v3 (Tier 1 #4) — 13-jun-2026.
-- Plan: docs/superpowers/plans/2026-06-12-mesa-modelo-reservas.md
-- Informe: docs/analisis-logica-2026-06/06-mesa-conexiones.md §3
--
-- 1) Estados nuevos: `sentada` (en mesa) separado del terminal `finalizada`.
--    Histórico `cumplida` → `finalizada`. Alias de compat: la RPC acepta
--    'cumplida' y lo trata como 'sentada' (bundles COMANDA viejos).
-- 2) Vínculo reserva↔venta bidireccional (venta_id) + auto-link al sentar,
--    link inverso al abrir venta en la mesa, y auto-finalizar al cobrar.
-- 3) cliente_id SIEMPRE: upsert con teléfono normalizado (fn_normalizar_telefono).
-- 4) mesas.capacidad NOT NULL DEFAULT 4.
-- 5) Cron pg_cron auto-no-show con gracia configurable por local.
-- 6) duracion_min por reserva con default por tamaño de grupo (JSONB config).
--
-- Versiones base copiadas (Step 0, vigentes al 13-jun):
--   fn_cambiar_estado_reserva        ← 202606100400_mesa_modulo1_nucleo_reservas.sql
--   fn_crear_reserva                 ← 202606100400_mesa_modulo1_nucleo_reservas.sql
--   fn_editar_reserva                ← 202606100400_mesa_modulo1_nucleo_reservas.sql
--   fn_crear_reserva_publica         ← 202605203600_reservas.sql
--   fn_check_disponibilidad_reserva  ← 202605203600_reservas.sql
--   fn_upsert_cliente_publico_comanda← 202605151730_f1_2_clientes.sql
--   fn_abrir_venta_comanda           ← 202605292000_fix_cross_tenant_service_role_y_abrir_venta_permiso.sql
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══ §1 Columnas y estados de `reservas` ════════════════════════════════════

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS venta_id      BIGINT REFERENCES ventas_pos(id),
  ADD COLUMN IF NOT EXISTS duracion_min  INTEGER,
  ADD COLUMN IF NOT EXISTS sentada_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalizada_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS no_show_auto  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_reservas_venta ON reservas(venta_id) WHERE venta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservas_mesa_sentada ON reservas(mesa_id) WHERE estado = 'sentada' AND deleted_at IS NULL;

-- OJO orden ≠ plan: el DROP del CHECK viejo va ANTES del UPDATE histórico —
-- el CHECK vigente (202605203600 inline, nombre default reservas_estado_check)
-- no incluye 'finalizada' y el UPDATE lo violaría.
ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_estado_check;

-- histórico: cumplida (terminal viejo) pasa a finalizada
UPDATE reservas SET estado = 'finalizada', finalizada_at = COALESCE(cumplida_at, updated_at)
 WHERE estado = 'cumplida';

ALTER TABLE reservas ADD CONSTRAINT reservas_estado_check
  CHECK (estado IN ('pendiente','confirmada','sentada','finalizada','no_show','cancelada'));

-- ═══ §2 mesas.capacidad NOT NULL ════════════════════════════════════════════

UPDATE mesas SET capacidad = 4 WHERE capacidad IS NULL;
ALTER TABLE mesas
  ALTER COLUMN capacidad SET NOT NULL,
  ALTER COLUMN capacidad SET DEFAULT 4;
ALTER TABLE mesas DROP CONSTRAINT IF EXISTS chk_mesas_capacidad;
ALTER TABLE mesas ADD CONSTRAINT chk_mesas_capacidad CHECK (capacidad > 0);

-- ═══ §3 Config por local ════════════════════════════════════════════════════

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_no_show_gracia_min INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reservas_duracion_por_personas JSONB NOT NULL DEFAULT
    '[{"hasta":2,"min":90},{"hasta":4,"min":105},{"hasta":6,"min":120},{"hasta":99,"min":150}]'::jsonb;

COMMENT ON COLUMN comanda_local_settings.reservas_no_show_gracia_min IS
  'Minutos de gracia tras fecha_hora antes de que el cron marque no_show una confirmada. Default 30.';
COMMENT ON COLUMN comanda_local_settings.reservas_duracion_por_personas IS
  'Tabla de duración default por tamaño de grupo: [{hasta, min}] ordenada ascendente.';

-- ═══ §4 Normalización de teléfono (IMMUTABLE + índice funcional NO único) ═══

CREATE OR REPLACE FUNCTION fn_normalizar_telefono(p_tel TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    regexp_replace(                                   -- 4. saca 0 inicial (prefijo nacional)
      regexp_replace(                                 -- 3. saca 9 inicial (móvil post-54)
        regexp_replace(                               -- 2. saca 54 inicial (país)
          regexp_replace(                             -- 1. saca 00 inicial + no-dígitos
            regexp_replace(COALESCE(p_tel,''), '[^0-9]', '', 'g'),
            '^00', ''),
          '^54', ''),
        '^9', ''),
      '^0', ''),
  '');
$$;
REVOKE ALL ON FUNCTION fn_normalizar_telefono(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_normalizar_telefono(TEXT) TO authenticated, anon, service_role;
-- (anon SÍ la necesita: corre dentro de las RPCs públicas SECURITY DEFINER, el GRANT
--  directo es inocuo porque es IMMUTABLE y pura)

CREATE INDEX IF NOT EXISTS idx_clientes_tel_norm
  ON clientes (tenant_id, fn_normalizar_telefono(telefono)) WHERE deleted_at IS NULL;
-- NO unique: hay clientes pre-existentes que pueden normalizar igual; el unique
-- llega después de un merge manual (documentado como pendiente).

-- ═══ §5 fn_upsert_cliente_publico_comanda v2 — lookup + canónico normalizado ═
-- Base: 202605151730_f1_2_clientes.sql. Cambia SOLO: lookup por teléfono
-- normalizado + el INSERT guarda el normalizado como canónico (con fallback a
-- trim() si normaliza a NULL — clientes.telefono es NOT NULL con CHECK len>0).

CREATE OR REPLACE FUNCTION fn_upsert_cliente_publico_comanda(
  p_local_slug TEXT,
  p_telefono TEXT,
  p_nombre TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_direccion TEXT DEFAULT NULL,
  p_direccion_aclaracion TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_cliente_id BIGINT;
BEGIN
  IF p_telefono IS NULL OR length(trim(p_telefono)) = 0 THEN
    RAISE EXCEPTION 'TELEFONO_REQUERIDO';
  END IF;

  SELECT cls.tenant_id INTO v_tenant_id
    FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  -- Buscar cliente existente por telefono NORMALIZADO + tenant (v3: unifica
  -- '+54 9 11 5555-1234' ≡ '011 5555-1234' ≡ '11-5555-1234').
  SELECT id INTO v_cliente_id
    FROM clientes
   WHERE tenant_id = v_tenant_id
     AND fn_normalizar_telefono(telefono) = fn_normalizar_telefono(p_telefono)
     AND deleted_at IS NULL
   LIMIT 1;

  IF v_cliente_id IS NULL THEN
    -- Crear nuevo (telefono canónico = normalizado).
    INSERT INTO clientes (tenant_id, telefono, nombre, email, direccion, direccion_aclaracion)
    VALUES (v_tenant_id, COALESCE(fn_normalizar_telefono(p_telefono), trim(p_telefono)),
            p_nombre, p_email, p_direccion, p_direccion_aclaracion)
    RETURNING id INTO v_cliente_id;
  ELSE
    -- Enriquecer si nuevos valores vienen y los actuales son NULL.
    UPDATE clientes SET
      nombre = COALESCE(nombre, p_nombre),
      email = COALESCE(email, p_email),
      direccion = COALESCE(p_direccion, direccion),  -- pisa con el último valor (puede mudarse)
      direccion_aclaracion = COALESCE(p_direccion_aclaracion, direccion_aclaracion),
      updated_at = NOW()
    WHERE id = v_cliente_id;
  END IF;

  RETURN v_cliente_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_upsert_cliente_publico_comanda(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_upsert_cliente_publico_comanda(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ═══ §6 Helper de duración default por tamaño de grupo ══════════════════════

CREATE OR REPLACE FUNCTION fn_duracion_reserva_default(p_local_id INTEGER, p_personas INTEGER)
RETURNS INTEGER LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tabla JSONB; v_item JSONB; v_fallback INTEGER;
BEGIN
  SELECT reservas_duracion_por_personas, COALESCE(reservas_duracion_estimada_min, 90)
    INTO v_tabla, v_fallback
    FROM comanda_local_settings WHERE local_id = p_local_id;
  IF v_tabla IS NULL THEN RETURN COALESCE(v_fallback, 90); END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_tabla)
  LOOP
    IF p_personas <= (v_item->>'hasta')::INT THEN RETURN (v_item->>'min')::INT; END IF;
  END LOOP;
  RETURN COALESCE(v_fallback, 90);
END; $$;
REVOKE ALL ON FUNCTION fn_duracion_reserva_default(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_duracion_reserva_default(INTEGER, INTEGER) TO authenticated, service_role;

-- ═══ §7 fn_cambiar_estado_reserva v2 — máquina de estados con sentada ═══════
-- Base: 202606100400_mesa_modulo1_nucleo_reservas.sql (firma 4 args, IDÉNTICA).
-- Cambios: alias 'cumplida'→'sentada' AL PRINCIPIO; transiciones nuevas
-- (sentada → finalizada); al sentar: upsert INLINE de cliente (tenant ya
-- resuelto — no se llama la RPC pública con slug derivado) + auto-link de la
-- venta viva de la mesa; timestamps sentada_at/finalizada_at.

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
  v_cliente_id bigint;
  v_venta_id bigint;
  v_mesa_link bigint;
BEGIN
  -- Alias de compat: bundles COMANDA viejos mandan 'cumplida' al sentar.
  -- Con el modelo v3 'cumplida' ya no existe — se interpreta como 'sentada'.
  IF p_nuevo_estado = 'cumplida' THEN p_nuevo_estado := 'sentada'; END IF;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT * INTO v_r FROM reservas
   WHERE id = p_reserva_id AND tenant_id = v_tenant AND deleted_at IS NULL
   FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'RESERVA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_r.local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_nuevo_estado NOT IN ('confirmada', 'sentada', 'finalizada', 'no_show', 'cancelada') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO';
  END IF;

  -- Máquina de estados (Tier1 #4):
  --   pendiente  → confirmada | sentada (walk-in) | cancelada
  --   confirmada → sentada | no_show | cancelada
  --   sentada    → finalizada
  --   terminales (finalizada/no_show/cancelada) → nada
  v_permitidas := CASE v_r.estado
    WHEN 'pendiente'  THEN ARRAY['confirmada', 'sentada', 'cancelada']
    WHEN 'confirmada' THEN ARRAY['sentada', 'no_show', 'cancelada']
    WHEN 'sentada'    THEN ARRAY['finalizada']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (p_nuevo_estado = ANY(v_permitidas)) THEN
    RAISE EXCEPTION 'RESERVA_TRANSICION_INVALIDA: % → %', v_r.estado, p_nuevo_estado;
  END IF;

  -- Sentar con mesa opcional (solo aplica al pasar a sentada).
  IF p_mesa_id IS NOT NULL THEN
    IF p_nuevo_estado != 'sentada' THEN
      RAISE EXCEPTION 'MESA_SOLO_AL_SENTAR';
    END IF;
    SELECT local_id INTO v_local_mesa FROM mesas WHERE id = p_mesa_id AND deleted_at IS NULL;
    IF v_local_mesa IS NULL THEN RAISE EXCEPTION 'MESA_NO_ENCONTRADA'; END IF;
    IF v_local_mesa != v_r.local_id THEN RAISE EXCEPTION 'MESA_OTRO_LOCAL'; END IF;
  END IF;

  IF p_nuevo_estado = 'sentada' THEN
    -- (a) Upsert de cliente INLINE, best-effort (tenant ya resuelto; misma
    --     lógica que fn_upsert_cliente_publico_comanda v2 con tel normalizado).
    v_cliente_id := v_r.cliente_id;
    IF v_cliente_id IS NULL AND v_r.cliente_telefono IS NOT NULL
       AND length(trim(v_r.cliente_telefono)) >= 6 THEN
      BEGIN
        SELECT id INTO v_cliente_id
          FROM clientes
         WHERE tenant_id = v_tenant
           AND fn_normalizar_telefono(telefono) = fn_normalizar_telefono(v_r.cliente_telefono)
           AND deleted_at IS NULL
         LIMIT 1;
        IF v_cliente_id IS NULL THEN
          INSERT INTO clientes (tenant_id, telefono, nombre, email)
          VALUES (v_tenant,
                  COALESCE(fn_normalizar_telefono(v_r.cliente_telefono), trim(v_r.cliente_telefono)),
                  v_r.cliente_nombre, v_r.cliente_email)
          RETURNING id INTO v_cliente_id;
        ELSE
          UPDATE clientes SET
            nombre = COALESCE(nombre, v_r.cliente_nombre),
            email  = COALESCE(email,  v_r.cliente_email),
            updated_at = NOW()
          WHERE id = v_cliente_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_cliente_id := NULL; -- best-effort: no romper el sentado por el CRM
      END;
    END IF;

    -- (b) Auto-link de venta viva en la mesa (si no está linkeada a otra reserva).
    v_mesa_link := COALESCE(p_mesa_id, v_r.mesa_id);
    IF v_mesa_link IS NOT NULL THEN
      SELECT vp.id INTO v_venta_id
        FROM ventas_pos vp
       WHERE vp.mesa_id = v_mesa_link
         AND vp.local_id = v_r.local_id
         AND vp.estado IN ('abierta', 'enviada', 'lista', 'entregada')
         AND vp.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM reservas r2
            WHERE r2.venta_id = vp.id AND r2.deleted_at IS NULL
         )
       ORDER BY vp.created_at DESC
       LIMIT 1;
      IF v_venta_id IS NOT NULL AND v_cliente_id IS NOT NULL THEN
        UPDATE ventas_pos SET cliente_id = COALESCE(cliente_id, v_cliente_id)
         WHERE id = v_venta_id;
      END IF;
    END IF;
  END IF;

  UPDATE reservas SET
    estado = p_nuevo_estado,
    mesa_id = COALESCE(p_mesa_id, mesa_id),
    cliente_id = COALESCE(v_cliente_id, cliente_id),
    venta_id = COALESCE(v_venta_id, venta_id),
    confirmada_at = CASE WHEN p_nuevo_estado = 'confirmada'  THEN NOW() ELSE confirmada_at END,
    sentada_at    = CASE WHEN p_nuevo_estado = 'sentada'     THEN NOW() ELSE sentada_at END,
    finalizada_at = CASE WHEN p_nuevo_estado = 'finalizada'  THEN NOW() ELSE finalizada_at END,
    cancelada_at  = CASE WHEN p_nuevo_estado = 'cancelada'   THEN NOW() ELSE cancelada_at END,
    motivo_cancelacion = CASE WHEN p_nuevo_estado = 'cancelada' THEN NULLIF(trim(COALESCE(p_motivo, '')), '') ELSE motivo_cancelacion END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cambiar_estado_reserva(bigint, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cambiar_estado_reserva(bigint, text, text, bigint) TO authenticated, service_role;

-- ═══ §8a fn_crear_reserva v2 (manual) — cliente_id + duracion_min ═══════════
-- Base: 202606100400. Cambios: upsert best-effort INLINE de cliente (no
-- existía) + duracion_min default por tamaño de grupo.

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
  v_cliente_id bigint;
  v_duracion integer;
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

  -- v3: duración default por tamaño de grupo.
  v_duracion := fn_duracion_reserva_default(p_local_id, p_personas);

  -- v3: upsert best-effort INLINE de cliente (tenant ya resuelto, tel normalizado).
  IF p_cliente_telefono IS NOT NULL AND length(trim(p_cliente_telefono)) >= 6 THEN
    BEGIN
      SELECT id INTO v_cliente_id
        FROM clientes
       WHERE tenant_id = v_tenant
         AND fn_normalizar_telefono(telefono) = fn_normalizar_telefono(p_cliente_telefono)
         AND deleted_at IS NULL
       LIMIT 1;
      IF v_cliente_id IS NULL THEN
        INSERT INTO clientes (tenant_id, telefono, nombre, email)
        VALUES (v_tenant,
                COALESCE(fn_normalizar_telefono(p_cliente_telefono), trim(p_cliente_telefono)),
                trim(p_cliente_nombre),
                NULLIF(trim(COALESCE(p_cliente_email, '')), ''))
        RETURNING id INTO v_cliente_id;
      ELSE
        UPDATE clientes SET
          nombre = COALESCE(nombre, trim(p_cliente_nombre)),
          email  = COALESCE(email, NULLIF(trim(COALESCE(p_cliente_email, '')), '')),
          updated_at = NOW()
        WHERE id = v_cliente_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_cliente_id := NULL; -- best-effort: la reserva no se cae por el CRM
    END;
  END IF;

  INSERT INTO reservas (
    tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
    cliente_id, fecha_hora, personas, duracion_min, notas, estado, idempotency_key
  ) VALUES (
    v_tenant, p_local_id, trim(p_cliente_nombre),
    NULLIF(trim(COALESCE(p_cliente_telefono, '')), ''),
    NULLIF(trim(COALESCE(p_cliente_email, '')), ''),
    v_cliente_id, p_fecha_hora, p_personas, v_duracion,
    NULLIF(trim(COALESCE(p_notas, '')), ''),
    'pendiente', p_idempotency_key
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_crear_reserva(integer, text, text, text, timestamptz, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_crear_reserva(integer, text, text, text, timestamptz, integer, text, text) TO authenticated, service_role;

-- ═══ §8b fn_editar_reserva v2 — recalcula duracion_min si cambian personas ══
-- Base: 202606100400. Cambio: si p_personas viene y difiere, se recalcula
-- duracion_min con el default por grupo. Simplificación documentada: no hay
-- flag de "seteado manual", así que SIEMPRE que cambia personas se recalcula.

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
    duracion_min = CASE WHEN p_personas IS NOT NULL AND p_personas <> v_r.personas
                        THEN fn_duracion_reserva_default(v_r.local_id, p_personas)
                        ELSE duracion_min END,
    notas      = CASE WHEN p_notas IS NULL THEN notas ELSE NULLIF(trim(p_notas), '') END,
    updated_at = NOW()
  WHERE id = p_reserva_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_editar_reserva(bigint, text, text, text, timestamptz, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_editar_reserva(bigint, text, text, text, timestamptz, integer, text) TO authenticated, service_role;

-- ═══ §8c fn_crear_reserva_publica v2 — captura cliente_id + duracion_min ════
-- Base: 202605203600. Cambios: duracion_min default por grupo en el INSERT +
-- el upsert best-effort (que ya existía y DESCARTABA el id) ahora captura el
-- id y lo asigna a reservas.cliente_id dentro del mismo bloque best-effort.

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
  v_cliente_id BIGINT;
  v_duracion INTEGER;
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

  -- v3: duración default por tamaño de grupo.
  v_duracion := fn_duracion_reserva_default(v_local_id, p_personas);

  INSERT INTO reservas (
    tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
    fecha_hora, personas, duracion_min, notas, estado, idempotency_key,
    confirmada_at
  ) VALUES (
    v_tenant_id, v_local_id, trim(p_cliente_nombre),
    NULLIF(trim(p_cliente_telefono), ''), NULLIF(trim(p_cliente_email), ''),
    p_fecha_hora, p_personas, v_duracion, NULLIF(trim(p_notas), ''), v_estado_inicial, p_idempotency_key,
    CASE WHEN v_estado_inicial = 'confirmada' THEN NOW() ELSE NULL END
  ) RETURNING reservas.id INTO v_new_id;

  -- Upsert cliente (mejor esfuerzo). Firma:
  --   (p_local_slug, p_telefono, p_nombre, p_email, p_direccion, p_direccion_aclaracion)
  -- v3: se captura el id retornado y se asigna a la reserva (antes se descartaba).
  IF p_cliente_telefono IS NOT NULL AND length(trim(p_cliente_telefono)) >= 6 THEN
    BEGIN
      v_cliente_id := fn_upsert_cliente_publico_comanda(
        p_local_slug, trim(p_cliente_telefono), trim(p_cliente_nombre),
        NULLIF(trim(p_cliente_email), ''), NULL, NULL
      );
      IF v_cliente_id IS NOT NULL THEN
        UPDATE reservas SET cliente_id = v_cliente_id, updated_at = NOW()
         WHERE reservas.id = v_new_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Best effort — no romper la reserva si falla el upsert cliente
      NULL;
    END;
  END IF;

  RETURN QUERY SELECT v_new_id, v_estado_inicial;
END;
$$;

REVOKE ALL ON FUNCTION fn_crear_reserva_publica(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_crear_reserva_publica(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT) TO anon, authenticated;

-- ═══ §9 fn_abrir_venta_comanda v2 — link inverso reserva sentada → venta ════
-- Base: 202605292000 (vigente, 15 args — firma IDÉNTICA, los wrappers _offline
-- no la llaman pero el contrato no cambia). Cambio: tras el INSERT, si vino
-- p_mesa_id, linkea la reserva sentada sin venta más cercana a NOW() (subselect
-- LIMIT 1 — UPDATE..RETURNING INTO multi-fila fallaría) y copia cliente_id.

CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda(
  p_local_id INTEGER,
  p_modo TEXT,
  p_canal_id INTEGER,
  p_mesa_id BIGINT DEFAULT NULL,
  p_mozo_id UUID DEFAULT NULL,
  p_cajero_id UUID DEFAULT NULL,
  p_cliente_nombre TEXT DEFAULT NULL,
  p_cliente_telefono TEXT DEFAULT NULL,
  p_cliente_direccion TEXT DEFAULT NULL,
  p_covers INTEGER DEFAULT NULL,
  p_origen TEXT DEFAULT 'pos',
  p_tipo_entrega TEXT DEFAULT NULL,
  p_estado TEXT DEFAULT 'abierta',
  p_programada_para TIMESTAMPTZ DEFAULT NULL,
  p_cliente_id BIGINT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_id BIGINT;
  v_numero INTEGER;
  v_turno_id BIGINT;
  v_reserva_cliente BIGINT;
BEGIN
  -- Fix 29-may: aceptar 'comanda.ventas.abrir' OR 'comanda.ventas.cobrar'
  -- (antes solo .cobrar — inconsistente, un mozo con solo .abrir no podía
  -- abrir mesas). Backward-compat: cualquiera de los 2 permite abrir.
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

  -- MESA v3 (Tier1 #4): link inverso — si hay una reserva SENTADA sin venta en
  -- esta mesa (ventana fecha_hora −4h/+2h), linkearla y copiar su cliente_id.
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

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_abrir_venta_comanda(INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_abrir_venta_comanda(INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT) TO authenticated, service_role;

-- ═══ §10 Auto-finalizar al cobrar (trigger nuevo, NO toca los existentes) ═══

CREATE OR REPLACE FUNCTION fn_trg_venta_pos_finalizar_reserva()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = 'cobrada' AND (OLD.estado IS NULL OR OLD.estado <> 'cobrada') THEN
    UPDATE reservas SET estado = 'finalizada', finalizada_at = NOW(), updated_at = NOW()
     WHERE venta_id = NEW.id AND estado = 'sentada' AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_venta_pos_finalizar_reserva ON ventas_pos;
CREATE TRIGGER trg_venta_pos_finalizar_reserva
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW EXECUTE FUNCTION fn_trg_venta_pos_finalizar_reserva();

-- ═══ §11 Cron auto-no-show (mismo patrón pg_cron que 202606021500) ══════════

CREATE OR REPLACE FUNCTION fn_cron_auto_no_show()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE reservas r
     SET estado = 'no_show', no_show_auto = TRUE, updated_at = NOW()
    FROM comanda_local_settings s
   WHERE s.local_id = r.local_id
     AND r.estado = 'confirmada'
     AND r.deleted_at IS NULL
     AND r.fecha_hora < NOW() - make_interval(mins => COALESCE(s.reservas_no_show_gracia_min, 30));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION fn_cron_auto_no_show() FROM PUBLIC, anon, authenticated;
-- solo pg_cron / service_role la ejecutan
GRANT EXECUTE ON FUNCTION fn_cron_auto_no_show() TO service_role;

-- NOTA: reservas con fecha_hora pasada y estado 'pendiente' NO se tocan
-- (todavía no confirmadas — el dueño decide); solo confirmadas. Las que el
-- cron marca quedan con no_show_auto = TRUE para revisión.
DO $$
BEGIN
  PERFORM cron.unschedule('mesa-auto-no-show') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'mesa-auto-no-show'
  );
  PERFORM cron.schedule(
    'mesa-auto-no-show',
    '*/10 * * * *',
    $cmd$ SELECT fn_cron_auto_no_show(); $cmd$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible o sin permisos — agendar mesa-auto-no-show a mano. Error: %', SQLERRM;
END $$;

-- ═══ §12 fn_check_disponibilidad_reserva v2 — solapamiento real por duración ═
-- Base: 202605203600 (firma y columnas de retorno IDÉNTICAS). Cambios: cuenta
-- pendiente+confirmada+SENTADA y el solapamiento usa [fecha_hora, fecha_hora +
-- duracion_min) de cada reserva contra [p_fecha_hora, p_fecha_hora + dur_pedida)
-- (antes: ventana simétrica ± duración global del local).

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
  v_dur_pedida INTEGER;
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

  -- v3: duración pedida por tamaño de grupo + solapamiento real de intervalos.
  -- Unidad = CUBIERTOS contra reservas_capacidad_max (motor de slots = módulo #2).
  v_dur_pedida := COALESCE(fn_duracion_reserva_default(v_local_id, p_personas), 90);

  SELECT COALESCE(SUM(r.personas), 0) INTO v_actuales
  FROM reservas r
  WHERE r.local_id = v_local_id
    AND r.estado IN ('pendiente', 'confirmada', 'sentada')
    AND r.deleted_at IS NULL
    AND r.fecha_hora < p_fecha_hora + make_interval(mins => v_dur_pedida)
    AND r.fecha_hora + make_interval(mins => COALESCE(r.duracion_min, v_duracion, 90)) > p_fecha_hora;

  IF v_actuales + p_personas > v_capacidad THEN
    RETURN QUERY SELECT FALSE, 'SIN_CUPO', v_actuales, v_capacidad; RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'OK'::TEXT, v_actuales, v_capacidad;
END;
$$;

REVOKE ALL ON FUNCTION fn_check_disponibilidad_reserva(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_check_disponibilidad_reserva(TEXT, TIMESTAMPTZ, INTEGER) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
