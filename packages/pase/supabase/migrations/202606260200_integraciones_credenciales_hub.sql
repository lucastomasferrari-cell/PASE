-- ═══════════════════════════════════════════════════════════════════════════
-- Hub de credenciales — extender tabla integraciones (creada en 202606250600)
-- 26-jun-2026
--
-- La tabla `integraciones` se creó en 202606250600 con (tenant_id, provider,
-- estado, config jsonb, conectado_at). Ahora la enriquecemos para que sea el
-- HUB ÚNICO donde Lucas pega tokens y las apps automáticamente los usan en
-- vez de env vars globales (multi-tenant friendly).
--
-- Columnas nuevas:
--   - ultima_verificacion_at: cuándo se hizo el último health-check
--   - ultimo_error: mensaje de error si la última verificación falló
--   - notas: comentario libre del dueño ("Cuenta de Anto", "Backup", etc)
--   - updated_by: quién hizo el último cambio (auditoría)
--
-- Constraint en provider para asegurar valores válidos.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'integraciones') THEN
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS ultima_verificacion_at TIMESTAMPTZ';
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS ultimo_error TEXT';
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS notas TEXT';
    EXECUTE 'ALTER TABLE integraciones ADD COLUMN IF NOT EXISTS updated_by INTEGER';

    -- Constraint en provider: solo valores conocidos.
    EXECUTE 'ALTER TABLE integraciones DROP CONSTRAINT IF EXISTS integraciones_provider_check';
    EXECUTE $C$ALTER TABLE integraciones ADD CONSTRAINT integraciones_provider_check CHECK (
      provider IN ('whatsapp_api','email','meta_ads','google_ads','search_console','instagram','google_maps','stripe','mp_point')
    )$C$;

    -- Constraint en estado.
    EXECUTE 'ALTER TABLE integraciones DROP CONSTRAINT IF EXISTS integraciones_estado_check';
    EXECUTE $C$ALTER TABLE integraciones ADD CONSTRAINT integraciones_estado_check CHECK (
      estado IN ('desconectado','conectado','error','probando')
    )$C$;
  END IF;
END $$;

COMMENT ON TABLE integraciones IS
  'Hub central de credenciales por tenant. Cada fila = un provider conectado. El dueño pega tokens via app Accesos o COMANDA Settings → Integraciones. Los endpoints serverless (whatsapp-send, email-send, etc) leen de esta tabla en vez de env vars globales.';

COMMENT ON COLUMN integraciones.config IS
  'JSONB con las credenciales del provider. Estructuras esperadas: '
  '{"phone_number_id":"...","access_token":"..."} para whatsapp_api; '
  '{"api_key":"...","from":"..."} para email; '
  '{"access_token":"...","ad_account_id":"..."} para meta_ads; '
  '{"api_key":"...","place_id":"..."} para google_maps; '
  '{"secret_key":"...","webhook_secret":"..."} para stripe.';

COMMIT;
