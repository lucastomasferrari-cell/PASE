-- ─────────────────────────────────────────────────────────────────────────
-- notificaciones_pendientes + trigger fuga + push tipo stock_posible_fuga
-- ─────────────────────────────────────────────────────────────────────────
--
-- Cierra el ticket v2 de "Push automático Posible Fuga" anotado el 24-may
-- (v1 ya tiene alert visual en pantalla, commit `4f0f416`). Esta v2 manda
-- push REAL al celu del dueño cuando un conteo termina con pérdida >$5k.
--
-- Arquitectura:
-- 1. Tabla `notificaciones_pendientes` (nueva) — cola de notificaciones
--    a despachar. Se popula via triggers + inserts directos. Se vacía
--    por un cron del bot IG.
-- 2. Trigger AFTER UPDATE en stock_conteos: cuando estado pasa a
--    'finalizado' AND valor_diferencia < -5000, INSERT en la cola.
-- 3. Bot IG tiene endpoint nuevo `/api/notif-pendientes-process.js`
--    (próxima migration es código, no SQL) que lee, manda push, marca.
-- 4. notification_preferences agrega tipo `stock_posible_fuga` opt-out.
--
-- Por qué tabla pendientes en lugar de push directo desde el trigger:
-- - Triggers SQL no pueden hacer HTTP (sería bloqueante + frágil)
-- - El cron del bot reusa la infra web-push existente (_lib/push.js)
-- - Si el bot está caído, la cola se procesa cuando vuelve
-- - Idempotente: cada notif tiene `enviado_at`, no se duplica
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notificaciones_pendientes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,  -- 'stock_posible_fuga' | etc.
  payload       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_at    TIMESTAMPTZ NULL,        -- NULL = pendiente
  enviado_count INTEGER NOT NULL DEFAULT 0,  -- a cuántos devices se mandó
  error_msg     TEXT NULL,               -- si falló, mensaje del último intento
  intentos      INTEGER NOT NULL DEFAULT 0  -- para retry exponencial con cap
);

CREATE INDEX IF NOT EXISTS idx_notif_pend_tenant_pendiente
  ON notificaciones_pendientes (tenant_id, enviado_at)
  WHERE enviado_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notif_pend_created
  ON notificaciones_pendientes (created_at);

ALTER TABLE notificaciones_pendientes ENABLE ROW LEVEL SECURITY;

-- Solo service_role escribe/lee (el bot la procesa, los users no la ven).
-- Si en el futuro hace falta UI de "ver cola pendiente para superadmin",
-- se agrega policy separada.
DROP POLICY IF EXISTS notif_pend_service_only ON notificaciones_pendientes;
CREATE POLICY notif_pend_service_only ON notificaciones_pendientes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE notificaciones_pendientes IS
  'Cola de notificaciones a despachar via push. Insert vía triggers o '
  'directo desde código. Vaciada por cron del bot IG cada 5min. '
  'Idempotente: cada fila se marca enviado_at cuando se procesa.';

-- ─── Trigger: stock_conteos finalizado con fuga grande ────────────────────
-- Dispara cuando un conteo pasa a estado='finalizado' Y la pérdida supera
-- el umbral ($5k = mismo que el alert UI v1).
CREATE OR REPLACE FUNCTION fn_trg_conteo_finalizado_check_fuga()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_umbral_pesos NUMERIC := -5000;  -- pérdida >$5k = "posible fuga"
  v_local_nombre TEXT;
BEGIN
  -- Solo cuando recién pasa a finalizado (no en updates posteriores)
  IF OLD.estado IS NOT DISTINCT FROM NEW.estado THEN RETURN NEW; END IF;
  IF NEW.estado <> 'finalizado' THEN RETURN NEW; END IF;
  IF NEW.valor_diferencia IS NULL OR NEW.valor_diferencia >= v_umbral_pesos THEN
    RETURN NEW;
  END IF;

  -- Buscar nombre del local para el payload
  SELECT nombre INTO v_local_nombre FROM locales WHERE id = NEW.local_id;

  -- Push: queda en cola, el bot la despacha
  INSERT INTO notificaciones_pendientes (tenant_id, tipo, payload)
  VALUES (
    NEW.tenant_id,
    'stock_posible_fuga',
    jsonb_build_object(
      'conteo_id', NEW.id,
      'local_id', NEW.local_id,
      'local_nombre', v_local_nombre,
      'valor_diferencia', NEW.valor_diferencia,
      'total_ajustes', NEW.total_ajustes,
      'movs_durante_conteo', COALESCE(NEW.movs_durante_conteo, 0),
      'finalizado_at', NEW.finalizado_at
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conteo_finalizado_check_fuga ON stock_conteos;
CREATE TRIGGER trg_conteo_finalizado_check_fuga
  AFTER UPDATE ON stock_conteos
  FOR EACH ROW EXECUTE FUNCTION fn_trg_conteo_finalizado_check_fuga();

COMMENT ON FUNCTION fn_trg_conteo_finalizado_check_fuga IS
  'Cuando un conteo se finaliza con pérdida >$5k, inserta una notif en '
  'notificaciones_pendientes tipo stock_posible_fuga. El bot IG la lee '
  'cada 5min y manda push al celu del dueño.';
