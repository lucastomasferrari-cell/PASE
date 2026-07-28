-- ═══════════════════════════════════════════════════════════════════════════
-- Reservas — atribución de marketing (de dónde viene cada reserva)
-- Sesión 2026-07-28
--
-- Para medir cuántas reservas llegan por pauta de Meta, IG orgánico, Google,
-- tráfico directo, etc. La página pública (packages/mesa) captura los UTM +
-- los click-ids (fbclid de Meta, gclid de Google) + el referrer al aterrizar,
-- y el endpoint /api/reservar los guarda en la reserva recién creada.
--
-- Nota: el alta pública pasa por fn_crear_reserva_publica (RPC grande). Para
-- NO tocar esa RPC, /api/reservar (service_role) hace un UPDATE de estos
-- campos sobre la reserva recién creada. Por eso alcanza con agregar columnas.
--
-- Todas nullable: una reserva cargada a mano por el local no tiene atribución.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS utm_source    TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium    TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
  ADD COLUMN IF NOT EXISTS utm_content   TEXT,
  ADD COLUMN IF NOT EXISTS utm_term      TEXT,
  ADD COLUMN IF NOT EXISTS fbclid        TEXT,
  ADD COLUMN IF NOT EXISTS gclid         TEXT,
  ADD COLUMN IF NOT EXISTS attr_referrer TEXT,
  ADD COLUMN IF NOT EXISTS attr_landing  TEXT;

COMMENT ON COLUMN reservas.utm_source   IS 'Atribución: fuente del tráfico (ej. instagram, google, facebook). NULL = manual/desconocido.';
COMMENT ON COLUMN reservas.utm_medium   IS 'Atribución: medio (ej. pauta/cpc, organico, email, referral).';
COMMENT ON COLUMN reservas.utm_campaign IS 'Atribución: nombre de la campaña.';
COMMENT ON COLUMN reservas.fbclid       IS 'Atribución: click id de Meta (para Conversions API / matching).';
COMMENT ON COLUMN reservas.gclid        IS 'Atribución: click id de Google Ads.';

-- Índice para el reporte "reservas por fuente" (por local + fecha).
CREATE INDEX IF NOT EXISTS idx_reservas_atribucion
  ON reservas (tenant_id, local_id, created_at)
  WHERE utm_source IS NOT NULL;

NOTIFY pgrst, 'reload schema';
