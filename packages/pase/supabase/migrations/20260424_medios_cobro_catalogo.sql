-- ═══════════════════════════════════════════════════════════════════════════
-- Catálogo dinámico de medios de cobro (refactor C).
-- Reemplaza el hardcoded constants.MEDIOS_COBRO + MEDIO_A_CUENTA por una
-- tabla editable desde Configuración. Permite que el dueño defina medios
-- distintos por local (ej: "Efectivo" sin sufijo en Belgrano).
--
-- local_id = NULL  → medio global (visible en todos los locales)
-- local_id = N     → medio específico de ese local
-- cuenta_destino: la cuenta de saldos_caja que impacta cuando entra venta.
--                 NULL = no impacta caja (tarjetas, online, etc).
-- activo = false   → no aparece en dropdowns ni matchea en importer, pero
--                    no se borra para no romper ventas históricas.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS medios_cobro (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  local_id integer REFERENCES locales(id) ON DELETE CASCADE,
  cuenta_destino text,
  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nombre, local_id)
);

ALTER TABLE medios_cobro ENABLE ROW LEVEL SECURITY;

-- Lectura abierta a todos los autenticados — los dropdowns y el importer
-- necesitan ver el catálogo en cualquier sección.
DROP POLICY IF EXISTS "mc_select" ON medios_cobro;
CREATE POLICY "mc_select" ON medios_cobro FOR SELECT TO authenticated USING (true);

-- Escritura: solo usuarios con permiso 'configuracion' (incluye dueño/admin
-- via auth_es_dueno_o_admin dentro del helper).
DROP POLICY IF EXISTS "mc_write" ON medios_cobro;
CREATE POLICY "mc_write" ON medios_cobro FOR ALL TO authenticated
  USING (auth_tiene_permiso('configuracion'))
  WITH CHECK (auth_tiene_permiso('configuracion'));

-- Seed inicial: los 16 medios canónicos como globales (local_id = NULL).
-- cuenta_destino refleja MEDIO_A_CUENTA actual: solo EFECTIVO* impactan caja.
-- ON CONFLICT no-op para que la migration sea idempotente.
INSERT INTO medios_cobro (nombre, local_id, cuenta_destino, orden) VALUES
  ('EFECTIVO SALON',     NULL, 'Caja Chica', 1),
  ('EFECTIVO DELIVERY',  NULL, 'Caja Chica', 2),
  ('EFECTIVO',           NULL, 'Caja Chica', 3),
  ('TARJETA DEBITO',     NULL, NULL,         4),
  ('TARJETA CREDITO',    NULL, NULL,         5),
  ('TRANSFERENCIA',      NULL, NULL,         6),
  ('QR',                 NULL, NULL,         7),
  ('LINK',               NULL, NULL,         8),
  ('Point Nave',         NULL, NULL,         9),
  ('Point MP',           NULL, NULL,        10),
  ('RAPPI ONLINE',       NULL, NULL,        11),
  ('PEYA ONLINE',        NULL, NULL,        12),
  ('MP DELIVERY',        NULL, NULL,        13),
  ('MASDELIVERY ONLINE', NULL, NULL,        14),
  ('BIGBOX',             NULL, NULL,        15),
  ('FANBAG',             NULL, NULL,        16)
ON CONFLICT (nombre, local_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_medios_cobro_local ON medios_cobro(local_id, activo);
