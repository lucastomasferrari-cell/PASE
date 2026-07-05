-- ============================================================
-- 202607052100_waitlist_publica.sql
-- Lista de espera PÚBLICA: cuando el widget no tiene lugar, el cliente
-- puede anotarse (además de escribir por WhatsApp). La anotación cae en
-- el panel MESA → Lista de espera, que ya existía para walk-ins.
--
-- - waitlist.fecha_deseada (date): qué día quería el cliente (walk-ins NULL).
-- - waitlist.origen: 'walkin' (staff) | 'online' (página pública).
-- - fn_waitlist_publica: RPC DEFINER para anon con anti-spam propio
--   (3 anotaciones activas por teléfono + ráfaga 10/5min por local).
-- ============================================================

BEGIN;

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS fecha_deseada date;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'walkin';

CREATE OR REPLACE FUNCTION public.fn_waitlist_publica(
  p_slug text, p_nombre text, p_telefono text, p_personas integer,
  p_fecha_deseada date DEFAULT NULL, p_notas text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local integer; v_tenant text; v_id bigint; v_n integer;
BEGIN
  SELECT s.local_id, l.tenant_id::text INTO v_local, v_tenant
  FROM comanda_local_settings s JOIN locales l ON l.id = s.local_id
  WHERE s.slug = p_slug AND s.deleted_at IS NULL AND s.reservas_activas;
  IF v_local IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  IF COALESCE(trim(p_nombre), '') = '' THEN RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;
  IF COALESCE(trim(p_telefono), '') = '' THEN RAISE EXCEPTION 'TELEFONO_REQUERIDO'; END IF;
  IF p_personas IS NULL OR p_personas < 1 OR p_personas > 50 THEN RAISE EXCEPTION 'PERSONAS_INVALIDAS'; END IF;
  IF p_fecha_deseada IS NOT NULL AND p_fecha_deseada < current_date THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;

  -- anti-spam: máx 3 anotaciones activas por teléfono en el local
  SELECT count(*) INTO v_n FROM waitlist
  WHERE local_id = v_local AND cliente_telefono = trim(p_telefono)
    AND estado IN ('esperando', 'llamado') AND deleted_at IS NULL;
  IF v_n >= 3 THEN RAISE EXCEPTION 'DEMASIADAS_ANOTACIONES'; END IF;

  -- anti-ráfaga: máx 10 anotaciones online cada 5 min por local
  SELECT count(*) INTO v_n FROM waitlist
  WHERE local_id = v_local AND origen = 'online'
    AND created_at > now() - interval '5 minutes' AND deleted_at IS NULL;
  IF v_n >= 10 THEN RAISE EXCEPTION 'DEMASIADO_RAPIDO'; END IF;

  INSERT INTO waitlist (tenant_id, local_id, cliente_nombre, cliente_telefono, personas,
                        notas, estado, fecha_deseada, origen)
  VALUES (v_tenant, v_local, trim(p_nombre), trim(p_telefono), p_personas,
          NULLIF(trim(COALESCE(p_notas, '')), ''), 'esperando', p_fecha_deseada, 'online')
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public.fn_waitlist_publica(text, text, text, integer, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_waitlist_publica(text, text, text, integer, date, text) TO anon, authenticated;

COMMIT;
