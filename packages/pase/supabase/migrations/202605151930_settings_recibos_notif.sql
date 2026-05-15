-- ═══════════════════════════════════════════════════════════════════════════
-- Settings de recibos + notificaciones en comanda_local_settings
-- ═══════════════════════════════════════════════════════════════════════════
-- Datos que aparecerán en ticket cuando se implemente impresión:
--   cuit, razon_social, condicion_iva, mensaje_recibo
--
-- Notificaciones:
--   sonido_kds_listo, sonido_pedido_nuevo, toast_visible
--
-- Todos opcionales (defaults sensatos). Ya hay comanda_local_settings:
-- slug, direccion, telefono, instagram, web, mp_qr_url, costo_envio_default,
-- tiempo_retiro_min, tiempo_delivery_min, tienda_activa, acepta_delivery,
-- autolock_minutos, features_pos_modos.

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS cuit TEXT,
  ADD COLUMN IF NOT EXISTS razon_social TEXT,
  ADD COLUMN IF NOT EXISTS condicion_iva TEXT,
  ADD COLUMN IF NOT EXISTS mensaje_recibo TEXT,
  ADD COLUMN IF NOT EXISTS sonido_kds_listo BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sonido_pedido_nuevo BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notif_push_pedidos BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN comanda_local_settings.cuit IS 'CUIT del negocio para mostrar en ticket fiscal.';
COMMENT ON COLUMN comanda_local_settings.razon_social IS 'Razón social legal del negocio.';
COMMENT ON COLUMN comanda_local_settings.condicion_iva IS 'IVA Responsable Inscripto / Monotributo / Exento.';
COMMENT ON COLUMN comanda_local_settings.mensaje_recibo IS 'Mensaje al pie del ticket. Ej: "Gracias por su visita".';
COMMENT ON COLUMN comanda_local_settings.sonido_kds_listo IS 'KDS hace bip cuando llega ticket nuevo.';
COMMENT ON COLUMN comanda_local_settings.sonido_pedido_nuevo IS 'POS hace bip cuando llega pedido online.';
COMMENT ON COLUMN comanda_local_settings.notif_push_pedidos IS 'Notificaciones push del navegador para pedidos (deuda: requiere setup PWA).';
