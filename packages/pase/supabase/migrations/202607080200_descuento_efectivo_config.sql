-- 202607080200 · Configuración del descuento efectivo por local
--
-- Lucas 2026-07-08: el % del descuento efectivo tiene que ser configurable
-- por local desde admin. 0 = deshabilitado (no aparece la opción en el POS).
-- 10 = 10%.

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS descuento_efectivo_pct numeric(5,2) NOT NULL DEFAULT 0
    CHECK (descuento_efectivo_pct >= 0 AND descuento_efectivo_pct <= 100);

COMMENT ON COLUMN comanda_local_settings.descuento_efectivo_pct IS
  '% del descuento por pago en efectivo aplicable desde el POS. 0 = deshabilitado.';

-- Seed inicial para los 3 Nekos (ya que Lucas usa 10% en Neko Devoto).
UPDATE comanda_local_settings
   SET descuento_efectivo_pct = 10
 WHERE local_id IN (1, 2, 3)
   AND descuento_efectivo_pct = 0;
