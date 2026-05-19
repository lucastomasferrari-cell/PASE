-- ═══════════════════════════════════════════════════════════════════════════
-- Gap #4 marketplace — notificaciones email adicionales
--
-- Mirror de 202605200100_ventas_pos_notif_email.sql con 2 columnas más:
--   - notif_email_rechazado_at: email "No pudimos tomar tu pedido"
--   - notif_email_entregado_at: email "¿Cómo estuvo? Calificá"
--
-- Idem patrón: NULL = no enviado. El endpoint chequea antes de mandar
-- y setea timestamp después. Si el cliente refresh / dispara doble, no
-- se duplica.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS notif_email_rechazado_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS notif_email_entregado_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN ventas_pos.notif_email_rechazado_at IS
  'Timestamp del email "No pudimos tomar tu pedido". NULL = no enviado.';
COMMENT ON COLUMN ventas_pos.notif_email_entregado_at IS
  'Timestamp del email "¿Cómo estuvo? Calificá". NULL = no enviado.';

NOTIFY pgrst, 'reload schema';
