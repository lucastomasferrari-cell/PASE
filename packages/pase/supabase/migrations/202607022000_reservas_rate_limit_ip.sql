-- ============================================================
-- 202607022000_reservas_rate_limit_ip.sql
-- Rate limiting por IP para el alta pública de reservas.
--
-- Contexto: el anti-abuso existente (202607021900) tiene topes por TELÉFONO y
-- por LOCAL, pero un bot puede rotar teléfonos/nombres y seguir golpeando el
-- canal. Este límite agrega una capa por IP: la función serverless
-- (/api/reservar) hashea la IP del request y llama a fn_rate_limit_hit antes de
-- crear la reserva. Se cuenta en ventanas fijas (bucket + ip_hash + ventana),
-- así un mismo origen no puede disparar ráfagas de altas aunque varíe los datos.
--
-- Piezas:
--   (a) Tabla reservas_rate_limit_ip — contador por ventana. RLS activo SIN
--       policies → sólo service_role / funciones DEFINER la alcanzan; anon y
--       authenticated quedan denegados por default.
--   (b) fn_rate_limit_hit(bucket, ip_hash, max, window_secs) — UPSERT atómico
--       que incrementa el contador de la ventana actual y devuelve si sigue
--       dentro del tope. Limpieza oportunista de ventanas viejas (~1% de las
--       veces) para no acumular filas.
--
-- El REVOKE de anon sobre fn_crear_reserva_publica va en una migración APARTE
-- (202607022010) que se aplica SÓLO cuando la función serverless ya está
-- deployada — si no, se cortan las altas en vivo hasta el deploy.
--
-- NO cambia el comportamiento para un cliente humano normal.
-- ============================================================

BEGIN;

-- ── (a) Contador por ventana ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservas_rate_limit_ip (
  bucket        text        NOT NULL,
  ip_hash       text        NOT NULL,
  window_start  timestamptz NOT NULL,
  cnt           integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, ip_hash, window_start)
);

-- RLS activo SIN policies: default-deny para anon/authenticated. Sólo el
-- service_role y las funciones SECURITY DEFINER llegan a la tabla.
ALTER TABLE reservas_rate_limit_ip ENABLE ROW LEVEL SECURITY;

-- Índice para la limpieza de ventanas viejas.
CREATE INDEX IF NOT EXISTS idx_reservas_rate_limit_ip_window
  ON reservas_rate_limit_ip (window_start);

-- ── (b) Registrar un golpe y devolver si sigue permitido ────────────────────
CREATE OR REPLACE FUNCTION public.fn_rate_limit_hit(
  p_bucket text, p_ip_hash text, p_max integer, p_window_secs integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_win timestamptz;
  v_cnt integer;
BEGIN
  -- Inicio de la ventana: piso de now() a un múltiplo de p_window_secs.
  v_win := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);

  -- Incremento atómico del contador de esta ventana.
  INSERT INTO reservas_rate_limit_ip(bucket, ip_hash, window_start, cnt)
  VALUES (p_bucket, p_ip_hash, v_win, 1)
  ON CONFLICT (bucket, ip_hash, window_start)
  DO UPDATE SET cnt = reservas_rate_limit_ip.cnt + 1
  RETURNING cnt INTO v_cnt;

  -- Limpieza oportunista de ventanas viejas (~1% de las veces, sólo en la 1ª
  -- inserción de la ventana) para no acumular filas sin agregar overhead a cada
  -- request. random() está permitido en runtime dentro de la función.
  IF v_cnt = 1 AND random() < 0.01 THEN
    DELETE FROM reservas_rate_limit_ip WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN v_cnt <= p_max;
END;
$function$;

-- Sólo el backend (service_role) la invoca. NO anon, NO authenticated.
-- OJO: Supabase tiene DEFAULT PRIVILEGES que auto-otorgan EXECUTE a anon/
-- authenticated en funciones nuevas del schema public → REVOKE FROM PUBLIC NO
-- alcanza; hay que revocar de anon/authenticated explícitamente.
REVOKE ALL ON FUNCTION public.fn_rate_limit_hit(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rate_limit_hit(text, text, integer, integer) TO service_role;

COMMIT;
