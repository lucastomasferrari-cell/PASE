-- ============================================================
-- 202607021900_reservas_seguridad_hardening.sql
-- Hardening de la superficie pública de reservas (auditoría 2-jul).
--
-- Arregla:
--   1. DoS del canal: el contador anti-ráfaga contaba TODAS las reservas de los
--      últimos 5 min (incluidas canceladas) → un bot creaba 12 y auto-cancelaba,
--      dejando el local sin reservas online. Ahora excluye cancelada/deleted.
--   2. Hueco "sin teléfono": el tope por teléfono se salteaba omitiendo el
--      teléfono. Se agrega un cap estricto para altas públicas sin teléfono.
--   3. Oráculo de token: fn_reserva_token_por_tel entregaba el cancel_token con
--      (id secuencial + teléfono) sin límite. El alta ahora DEVUELVE el token
--      directo (la pantalla de confirmación ya no lo necesita) → se revoca de anon.
--   4. Envenenamiento de CRM: fn_upsert_cliente_publico_comanda era anónima
--      directa. Se llama dentro del alta (SECURITY DEFINER) → se revoca de anon
--      sin romper el flujo.
--   5. Hardening DEFINER: se fija search_path en las 2 funciones que faltaban.
--   6. Idempotencia robusta: re-chequeo dentro del lock + manejo de la unique.
--
-- NO cambia el comportamiento para un cliente humano normal.
-- ============================================================

BEGIN;

-- ── (5) search_path en las funciones DEFINER públicas que faltaban ──────────
ALTER FUNCTION public.fn_check_disponibilidad_reserva(text, timestamptz, integer, text)
  SET search_path TO 'public';

-- ── (3+1+2+6) Alta pública reescrita ────────────────────────────────────────
-- Cambia el tipo de retorno (agrega cancel_token) → hay que DROP + CREATE.
DROP FUNCTION IF EXISTS public.fn_crear_reserva_publica(text, text, text, text, timestamptz, integer, text, text, text);
CREATE FUNCTION public.fn_crear_reserva_publica(
  p_local_slug text, p_cliente_nombre text, p_cliente_telefono text,
  p_cliente_email text, p_fecha_hora timestamp with time zone,
  p_personas integer, p_notas text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text,
  p_zona text DEFAULT NULL
)
RETURNS TABLE(id bigint, estado text, cancel_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID; v_local_id INTEGER; v_disponible BOOLEAN; v_motivo TEXT;
  v_existing BIGINT; v_new_id BIGINT; v_requiere_confirm BOOLEAN; v_estado_inicial TEXT;
  v_tel_oblig BOOLEAN; v_cliente_id BIGINT; v_duracion INTEGER; v_tel_norm TEXT;
  v_cnt_tel INTEGER; v_cnt_burst INTEGER; v_cnt_sin_tel INTEGER; v_motor TEXT; v_combinar BOOLEAN;
  v_hay_mesas BOOLEAN; v_usar_mesas BOOLEAN; v_mesas bigint[]; v_mesa_prim BIGINT;
  v_cancel_token UUID;
BEGIN
  -- Idempotency (fast path, fuera del lock)
  IF p_idempotency_key IS NOT NULL THEN
    SELECT r.id, r.cancel_token INTO v_existing, v_cancel_token FROM reservas r
    INNER JOIN comanda_local_settings cls ON cls.local_id = r.local_id
    WHERE cls.slug = p_local_slug AND r.idempotency_key = p_idempotency_key AND r.deleted_at IS NULL;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT v_existing, (SELECT r2.estado FROM reservas r2 WHERE r2.id = v_existing), v_cancel_token; RETURN;
    END IF;
  END IF;

  SELECT cls.local_id, l.tenant_id, cls.reservas_requiere_confirmacion, cls.reservas_telefono_obligatorio,
         COALESCE(cls.reservas_motor,'auto'), COALESCE(cls.reservas_permite_combinar,TRUE)
    INTO v_local_id, v_tenant_id, v_requiere_confirm, v_tel_oblig, v_motor, v_combinar
    FROM comanda_local_settings cls INNER JOIN locales l ON l.id = cls.local_id
    WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  IF v_tel_oblig AND (p_cliente_telefono IS NULL OR length(trim(p_cliente_telefono)) < 6) THEN
    RAISE EXCEPTION 'TELEFONO_REQUERIDO'; END IF;
  IF p_cliente_nombre IS NULL OR length(trim(p_cliente_nombre)) < 2 THEN
    RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;

  -- ── Anti-abuso ─────────────────────────────────────────────────────────
  v_tel_norm := regexp_replace(COALESCE(p_cliente_telefono,''), '[^0-9]', '', 'g');
  IF length(v_tel_norm) >= 6 THEN
    -- (a) máx 4 activas futuras por teléfono.
    SELECT COUNT(*) INTO v_cnt_tel FROM reservas r
    WHERE r.local_id = v_local_id
      AND regexp_replace(COALESCE(r.cliente_telefono,''),'[^0-9]','','g') = v_tel_norm
      AND r.estado IN ('pendiente','confirmada') AND r.fecha_hora > NOW() AND r.deleted_at IS NULL;
    IF v_cnt_tel >= 4 THEN RAISE EXCEPTION 'DEMASIADAS_RESERVAS'; END IF;
  ELSE
    -- (b) sin teléfono válido: cap estricto (cierra el hueco de omitir el tel
    --     para saltear el tope por número). Máx 3 sin-tel en 10 min por local.
    SELECT COUNT(*) INTO v_cnt_sin_tel FROM reservas r
    WHERE r.local_id = v_local_id
      AND length(regexp_replace(COALESCE(r.cliente_telefono,''),'[^0-9]','','g')) < 6
      AND r.created_at > NOW() - INTERVAL '10 minutes'
      AND r.estado <> 'cancelada' AND r.deleted_at IS NULL;
    IF v_cnt_sin_tel >= 3 THEN RAISE EXCEPTION 'DEMASIADO_RAPIDO'; END IF;
  END IF;
  -- (c) ráfaga por local: máx 12 en 5 min — EXCLUYE canceladas/borradas (antes
  --     un flood + auto-cancelación dejaba el canal bloqueado 5 min).
  SELECT COUNT(*) INTO v_cnt_burst FROM reservas r
  WHERE r.local_id = v_local_id AND r.created_at > NOW() - INTERVAL '5 minutes'
    AND r.estado <> 'cancelada' AND r.deleted_at IS NULL;
  IF v_cnt_burst >= 12 THEN RAISE EXCEPTION 'DEMASIADO_RAPIDO'; END IF;

  -- Serializar la asignación de mesa para este local.
  PERFORM pg_advisory_xact_lock(v_local_id::bigint);

  -- (6) Re-chequeo de idempotencia DENTRO del lock: si un request gemelo ya
  -- insertó, devolvemos esa reserva en vez de duplicar.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT r.id, r.cancel_token INTO v_existing, v_cancel_token FROM reservas r
    WHERE r.local_id = v_local_id AND r.idempotency_key = p_idempotency_key AND r.deleted_at IS NULL;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT v_existing, (SELECT r2.estado FROM reservas r2 WHERE r2.id = v_existing), v_cancel_token; RETURN;
    END IF;
  END IF;

  SELECT d.disponible, d.motivo INTO v_disponible, v_motivo
  FROM fn_check_disponibilidad_reserva(p_local_slug, p_fecha_hora, p_personas, p_zona) d;
  IF NOT v_disponible THEN RAISE EXCEPTION '%', v_motivo; END IF;

  v_duracion := fn_duracion_reserva_default(v_local_id, p_personas);

  SELECT EXISTS(SELECT 1 FROM mesas m WHERE m.local_id=v_local_id AND m.deleted_at IS NULL AND m.reservable
                  AND COALESCE(m.capacidad,0)>0 AND (p_zona IS NULL OR m.zona=p_zona))
    INTO v_hay_mesas;
  v_usar_mesas := (v_motor = 'mesas') OR (v_motor = 'auto' AND v_hay_mesas) OR (p_zona IS NOT NULL);
  IF v_usar_mesas THEN
    v_mesas := fn_buscar_mesas_reserva(v_local_id, p_fecha_hora, v_duracion, p_personas, v_combinar, p_zona);
    IF v_mesas IS NULL OR array_length(v_mesas,1) IS NULL THEN RAISE EXCEPTION 'SIN_MESA'; END IF;
    v_mesa_prim := v_mesas[1];
  END IF;

  v_estado_inicial := CASE WHEN v_requiere_confirm THEN 'pendiente' ELSE 'confirmada' END;

  -- (6) La unique parcial (local_id, idempotency_key) es el backstop final.
  BEGIN
    INSERT INTO reservas (
      tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
      fecha_hora, personas, duracion_min, notas, estado, idempotency_key,
      confirmada_at, mesa_id, mesas_ids
    ) VALUES (
      v_tenant_id, v_local_id, trim(p_cliente_nombre),
      NULLIF(trim(p_cliente_telefono), ''), NULLIF(trim(p_cliente_email), ''),
      p_fecha_hora, p_personas, v_duracion, NULLIF(trim(p_notas), ''), v_estado_inicial, p_idempotency_key,
      CASE WHEN v_estado_inicial = 'confirmada' THEN NOW() ELSE NULL END,
      v_mesa_prim, v_mesas
    ) RETURNING reservas.id, reservas.cancel_token INTO v_new_id, v_cancel_token;
  EXCEPTION WHEN unique_violation THEN
    SELECT r.id, r.estado, r.cancel_token INTO v_existing, v_estado_inicial, v_cancel_token
      FROM reservas r WHERE r.local_id = v_local_id AND r.idempotency_key = p_idempotency_key AND r.deleted_at IS NULL;
    RETURN QUERY SELECT v_existing, v_estado_inicial, v_cancel_token; RETURN;
  END;

  IF p_cliente_telefono IS NOT NULL AND length(trim(p_cliente_telefono)) >= 6 THEN
    BEGIN
      v_cliente_id := fn_upsert_cliente_publico_comanda(
        p_local_slug, trim(p_cliente_telefono), trim(p_cliente_nombre),
        NULLIF(trim(p_cliente_email), ''), NULL, NULL);
      IF v_cliente_id IS NOT NULL THEN
        UPDATE reservas SET cliente_id = v_cliente_id, updated_at = NOW() WHERE reservas.id = v_new_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN QUERY SELECT v_new_id, v_estado_inicial, v_cancel_token;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_crear_reserva_publica(text, text, text, text, timestamptz, integer, text, text, text) TO anon, authenticated, service_role;

-- ── (3) El oráculo de token-por-teléfono ya no hace falta en el cliente ──────
-- (el alta devuelve el token). Se revoca de anon para cerrar la enumeración
-- (id secuencial + teléfono → cancel_token). Sigue disponible para el staff.
REVOKE EXECUTE ON FUNCTION public.fn_reserva_token_por_tel(bigint, text) FROM anon;

-- ── (4) upsert de cliente: se llama dentro del alta (DEFINER); no debe ser
-- invocable directamente por anon (envenenamiento de CRM + oráculo de clientes).
REVOKE EXECUTE ON FUNCTION public.fn_upsert_cliente_publico_comanda(text, text, text, text, text, text) FROM anon;

COMMIT;
