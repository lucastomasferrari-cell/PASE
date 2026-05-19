-- ═══════════════════════════════════════════════════════════════════════════
-- Fase B item 3 — idempotency de notificaciones email
--
-- 2 columnas en ventas_pos para evitar mandar el mismo email dos veces:
--   - notif_email_recibido_at: marcado cuando se manda "Recibimos tu pedido"
--   - notif_email_listo_at:    marcado cuando se manda "Tu pedido está listo"
--
-- El endpoint /api/tienda-mp?action=notify-* chequea NULL antes de mandar
-- y setea timestamp después. Si el cliente refresh y reintenta, no se
-- duplica.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS notif_email_recibido_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS notif_email_listo_at    TIMESTAMPTZ NULL;

COMMENT ON COLUMN ventas_pos.notif_email_recibido_at IS
  'Timestamp del email "Recibimos tu pedido". NULL = no enviado. Usado para idempotency.';
COMMENT ON COLUMN ventas_pos.notif_email_listo_at IS
  'Timestamp del email "Tu pedido está listo". NULL = no enviado.';

NOTIFY pgrst, 'reload schema';
