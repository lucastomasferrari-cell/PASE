-- ============================================================
-- Reservas: anti-abuso en la RPC pública anónima.
--
-- `fn_crear_reserva_publica` está grant-eada a `anon` y no tenía ningún
-- límite: un bot con la anon key podía crear reservas ilimitadas (llenar el
-- cupo / spamear). Agregamos dos límites baratos, evaluados server-side
-- antes del INSERT:
--   1. Por teléfono: máx 4 reservas ACTIVAS futuras (pendiente/confirmada)
--      por número → DEMASIADAS_RESERVAS.
--   2. Ráfaga por local: máx 12 reservas creadas en los últimos 5 min por
--      local (creación pública) → DEMASIADO_RAPIDO.
-- No frena a un humano normal; sí corta enumeración/flood automatizado.
-- (Complementa; lo ideal a futuro es rate-limit por IP en el edge.)
--
-- Se re-crea la función completa manteniendo el resto idéntico.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_crear_reserva_publica(
  p_local_slug text, p_cliente_nombre text, p_cliente_telefono text,
  p_cliente_email text, p_fecha_hora timestamp with time zone,
  p_personas integer, p_notas text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS TABLE(id bigint, estado text)
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
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
  v_tel_norm TEXT;
  v_cnt_tel INTEGER;
  v_cnt_burst INTEGER;
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

  -- Validar disponibilidad (local existe + activas + horario + capacidad)
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

  -- ── Anti-abuso ─────────────────────────────────────────────────────────
  -- 1) Límite por teléfono: máx 4 reservas activas futuras.
  v_tel_norm := regexp_replace(COALESCE(p_cliente_telefono, ''), '[^0-9]', '', 'g');
  IF length(v_tel_norm) >= 6 THEN
    SELECT COUNT(*) INTO v_cnt_tel FROM reservas r
    WHERE r.local_id = v_local_id
      AND regexp_replace(COALESCE(r.cliente_telefono, ''), '[^0-9]', '', 'g') = v_tel_norm
      AND r.estado IN ('pendiente', 'confirmada')
      AND r.fecha_hora > NOW()
      AND r.deleted_at IS NULL;
    IF v_cnt_tel >= 4 THEN
      RAISE EXCEPTION 'DEMASIADAS_RESERVAS';
    END IF;
  END IF;
  -- 2) Ráfaga por local: máx 12 creadas en los últimos 5 minutos.
  SELECT COUNT(*) INTO v_cnt_burst FROM reservas r
  WHERE r.local_id = v_local_id AND r.created_at > NOW() - INTERVAL '5 minutes';
  IF v_cnt_burst >= 12 THEN
    RAISE EXCEPTION 'DEMASIADO_RAPIDO';
  END IF;

  v_estado_inicial := CASE WHEN v_requiere_confirm THEN 'pendiente' ELSE 'confirmada' END;
  v_duracion := fn_duracion_reserva_default(v_local_id, p_personas);

  INSERT INTO reservas (
    tenant_id, local_id, cliente_nombre, cliente_telefono, cliente_email,
    fecha_hora, personas, duracion_min, notas, estado, idempotency_key, confirmada_at
  ) VALUES (
    v_tenant_id, v_local_id, trim(p_cliente_nombre),
    NULLIF(trim(p_cliente_telefono), ''), NULLIF(trim(p_cliente_email), ''),
    p_fecha_hora, p_personas, v_duracion, NULLIF(trim(p_notas), ''), v_estado_inicial, p_idempotency_key,
    CASE WHEN v_estado_inicial = 'confirmada' THEN NOW() ELSE NULL END
  ) RETURNING reservas.id INTO v_new_id;

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
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN QUERY SELECT v_new_id, v_estado_inicial;
END;
$function$;
