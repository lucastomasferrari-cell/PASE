-- ═══════════════════════════════════════════════════════════════════════════
-- Pedidos externos log — auditoría de webhooks de Rappi / PedidosYa / MP
-- ═══════════════════════════════════════════════════════════════════════════
-- Cada vez que un partner externo nos manda un webhook, registramos el
-- payload completo + headers + venta creada (o NULL si falló). Sirve para:
-- - Debugging cuando un pedido externo no se procesa bien.
-- - Auditoría retroactiva si el partner reclama "te mandé X y no apareció".
-- - Re-procesamiento manual si el procesador falló silencioso.
--
-- NO contiene info financiera sensible — sólo metadatos de mensajes recibidos.
-- RLS open por tenant (cualquiera del tenant puede ver). El INSERT lo hace
-- el endpoint Vercel con service_role.

CREATE TABLE IF NOT EXISTS pedidos_externos_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  provider      TEXT NOT NULL,    -- 'rappi', 'pedidos-ya', 'mp'
  external_id   TEXT NULL,        -- ID del pedido/payment según el partner
  payload       JSONB NOT NULL,   -- body completo del webhook
  headers       JSONB NULL,       -- selección de headers relevantes (user-agent, signature)

  -- Resultado del procesamiento
  venta_id      BIGINT NULL REFERENCES ventas_pos(id),
  processed_at  TIMESTAMPTZ NULL,
  error         TEXT NULL,

  CONSTRAINT chk_provider CHECK (provider IN ('rappi', 'pedidos-ya', 'mp', 'whatsapp'))
);

CREATE INDEX IF NOT EXISTS idx_pel_tenant_created ON pedidos_externos_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pel_provider_created ON pedidos_externos_log(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pel_external ON pedidos_externos_log(provider, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE pedidos_externos_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pel_read ON pedidos_externos_log;
CREATE POLICY pel_read ON pedidos_externos_log FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS pel_service ON pedidos_externos_log;
CREATE POLICY pel_service ON pedidos_externos_log FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE pedidos_externos_log IS
  'Auditoría de webhooks recibidos de partners externos (Rappi, PedidosYa, MP). Insert desde Vercel function tienda-mp.js con service_role.';
