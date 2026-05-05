-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 2 — POS + Caja + Tienda online + Anti-fraude
--
-- Crea:
--   - PIN POS hasheado en rrhh_empleados (extiende la tabla)
--   - 9 tablas: mesas, turnos_caja, movimientos_caja, ventas_pos,
--     ventas_pos_items, ventas_pos_pagos, ventas_pos_overrides (inmutable),
--     metodos_cobro, comanda_local_settings
--   - 4 history tables (mesas, turnos_caja, ventas_pos, ventas_pos_items)
--   - Vista v_catalogo_publico (GRANT SELECT a anon, para tienda online)
--   - 21 RPCs: ticketing, abrir/cerrar venta, items, coursing, descuento,
--     cobro idempotente, anular/refund/reopen, transferir/unir/partir mesas,
--     turno caja apertura/cierre, movimientos, pedidos online (aprobar /
--     marcar_listo / marcar_entregado / crear_pedido_publico anon)
--   - RLS canónica PASE en todas las tablas nuevas
--   - Seeds: 6 métodos de cobro, comanda_local_settings con slug por local,
--     mesas por local (15+5+6 VC, 12+6+4 Belgrano, 5+0+0 fallback en otros)
--
-- Decisiones (confirmadas con el usuario en chat):
--   1. Dueño email/pass + bypass de PIN. Empleados con PIN atados a un local.
--   2. Tabla comanda_local_settings con slug, dirección, redes, mp_qr_url,
--      costo_envio_default. NO se toca tabla locales de PASE.
--   3. MP QR como imagen subida a Storage. Si mp_qr_url NULL, opción no aparece.
--   4. costo_envio_default NUMERIC(12,2) DEFAULT 0 — Lucas configura una vez.
--   5. Pedidos online se aceptan sin caja abierta. turno_caja_id se asigna al
--      momento de aprobar (RPC fn_aprobar_pedido_comanda).
--   6. Auto-lock cierra solo sesión POS (sessionStorage); Supabase queda viva.
--   7. PIN persiste en sessionStorage; muere al cerrar pestaña o auto-lock.
--
-- Patrón reusado: fn_set_updated_at() y fn_unaccent_immutable() ya existen
-- desde Sprint 1.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extension pgcrypto ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── 2. Extender rrhh_empleados (PIN POS, rol POS) ────────────────────────
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS pin_pos TEXT NULL;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS rol_pos TEXT NULL
  CHECK (rol_pos IS NULL OR rol_pos IN ('cajero', 'encargado', 'manager', 'dueno'));
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS pin_actualizado_at TIMESTAMPTZ NULL;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS pos_activo BOOLEAN NOT NULL DEFAULT FALSE;

-- PIN único por local (entre los activos)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pin_pos_per_local
  ON rrhh_empleados(local_id, pin_pos)
  WHERE pin_pos IS NOT NULL AND pos_activo = TRUE;

-- Setea PIN hasheado con bcrypt
CREATE OR REPLACE FUNCTION fn_set_pin_pos(p_empleado_id UUID, p_pin TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NOT (p_pin ~ '^\d{4}$') THEN
    RAISE EXCEPTION 'PIN_INVALIDO: debe ser exactamente 4 dígitos';
  END IF;
  IF NOT (auth_es_superadmin() OR auth_tiene_permiso('comanda.empleados.editar_pos')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_EDITAR_PIN';
  END IF;
  UPDATE rrhh_empleados SET
    pin_pos = crypt(p_pin, gen_salt('bf')),
    pin_actualizado_at = NOW()
  WHERE id = p_empleado_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_set_pin_pos(UUID, TEXT) TO authenticated;

-- Verifica PIN; retorna empleado_id (UUID) si matchea, NULL si no
CREATE OR REPLACE FUNCTION fn_verificar_pin_pos(p_local_id INTEGER, p_pin TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id
    FROM rrhh_empleados
   WHERE local_id = p_local_id
     AND pos_activo = TRUE
     AND activo = TRUE
     AND pin_pos IS NOT NULL
     AND pin_pos = crypt(p_pin, pin_pos)
   LIMIT 1;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_verificar_pin_pos(INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_verificar_pin_pos(INTEGER, TEXT) TO anon;
-- Anon también lo usa? No. Solo authenticated. Revertir grant a anon:
REVOKE EXECUTE ON FUNCTION fn_verificar_pin_pos(INTEGER, TEXT) FROM anon;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLAS
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── mesas ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mesas (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),
  version       INTEGER NOT NULL DEFAULT 1,

  numero        TEXT NOT NULL,
  zona          TEXT NULL,
  capacidad     INTEGER NULL,
  pos_x         INTEGER NULL,
  pos_y         INTEGER NULL,
  forma         TEXT NOT NULL DEFAULT 'cuadrado'
                CHECK (forma IN ('cuadrado', 'redondo', 'rectangular')),
  estado        TEXT NOT NULL DEFAULT 'libre'
                CHECK (estado IN ('libre', 'ocupada', 'hold', 'inactiva'))
);
CREATE INDEX IF NOT EXISTS idx_mesas_local ON mesas(local_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mesas_zona ON mesas(local_id, zona) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mesas_numero_per_local
  ON mesas(local_id, numero) WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_mesas_set_updated_at ON mesas;
CREATE TRIGGER trg_mesas_set_updated_at BEFORE UPDATE ON mesas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── turnos_caja ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS turnos_caja (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INTEGER NOT NULL DEFAULT 1,

  numero        INTEGER NOT NULL,
  cajero_id     UUID NOT NULL REFERENCES rrhh_empleados(id),
  abierto_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cerrado_at    TIMESTAMPTZ NULL,
  cerrado_por   UUID NULL REFERENCES rrhh_empleados(id),

  monto_inicial NUMERIC(12,2) NOT NULL DEFAULT 0,
  monto_final_declarado NUMERIC(12,2) NULL,
  monto_final_calculado NUMERIC(12,2) NULL,
  diferencia            NUMERIC(12,2) NULL,

  notas         TEXT NULL,
  estado        TEXT NOT NULL DEFAULT 'abierto'
                CHECK (estado IN ('abierto', 'cerrado'))
);
CREATE INDEX IF NOT EXISTS idx_turnos_caja_local_estado ON turnos_caja(local_id, estado);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_turno_numero_per_local ON turnos_caja(local_id, numero);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_turno_abierto_per_local
  ON turnos_caja(local_id) WHERE estado = 'abierto';
DROP TRIGGER IF EXISTS trg_turnos_caja_set_updated_at ON turnos_caja;
CREATE TRIGGER trg_turnos_caja_set_updated_at BEFORE UPDATE ON turnos_caja
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── movimientos_caja ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS movimientos_caja (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  turno_caja_id BIGINT NOT NULL REFERENCES turnos_caja(id),
  empleado_id   UUID NOT NULL REFERENCES rrhh_empleados(id),

  tipo          TEXT NOT NULL CHECK (tipo IN (
    'apertura', 'cierre', 'venta', 'venta_anulada', 'retiro', 'deposito', 'ajuste'
  )),
  monto         NUMERIC(12,2) NOT NULL,
  metodo        TEXT NOT NULL,
  motivo        TEXT NULL,
  venta_id      BIGINT NULL,
  ip_origen     TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_caja_turno ON movimientos_caja(turno_caja_id);
CREATE INDEX IF NOT EXISTS idx_mov_caja_local_fecha
  ON movimientos_caja(local_id, created_at DESC);

-- ─── ventas_pos ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ventas_pos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),
  version       INTEGER NOT NULL DEFAULT 1,

  numero_local  INTEGER NOT NULL,
  modo          TEXT NOT NULL CHECK (modo IN ('salon', 'mostrador', 'pedidos')),
  canal_id      INTEGER NOT NULL REFERENCES canales(id),
  turno_caja_id BIGINT NULL REFERENCES turnos_caja(id),

  mesa_id       BIGINT NULL REFERENCES mesas(id),
  mozo_id       UUID NULL REFERENCES rrhh_empleados(id),
  cajero_id     UUID NULL REFERENCES rrhh_empleados(id),
  cliente_nombre    TEXT NULL,
  cliente_telefono  TEXT NULL,
  cliente_direccion TEXT NULL,
  covers        INTEGER NULL,

  estado        TEXT NOT NULL DEFAULT 'abierta'
                CHECK (estado IN (
                  'abierta', 'enviada', 'lista', 'entregada',
                  'cobrada', 'anulada', 'necesita_aprobacion', 'programada'
                )),

  origen        TEXT NOT NULL DEFAULT 'pos'
                CHECK (origen IN ('pos', 'tienda_online', 'menu_qr')),
  programada_para TIMESTAMPTZ NULL,
  tipo_entrega  TEXT NULL CHECK (
    tipo_entrega IS NULL OR tipo_entrega IN ('retiro', 'delivery')
  ),

  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  descuento_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  propina         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,

  abierta_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviada_at    TIMESTAMPTZ NULL,
  cobrada_at    TIMESTAMPTZ NULL,
  anulada_at    TIMESTAMPTZ NULL,
  notas         TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_vp_local_estado
  ON ventas_pos(local_id, estado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vp_mesa_abierta
  ON ventas_pos(mesa_id) WHERE estado = 'abierta' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vp_turno
  ON ventas_pos(turno_caja_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vp_origen_estado
  ON ventas_pos(local_id, origen, estado) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vp_numero_per_local
  ON ventas_pos(local_id, numero_local);
DROP TRIGGER IF EXISTS trg_vp_set_updated_at ON ventas_pos;
CREATE TRIGGER trg_vp_set_updated_at BEFORE UPDATE ON ventas_pos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── ventas_pos_items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ventas_pos_items (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),
  version       INTEGER NOT NULL DEFAULT 1,

  venta_id      BIGINT NOT NULL REFERENCES ventas_pos(id),
  item_id       INTEGER NOT NULL REFERENCES items(id),
  cantidad      NUMERIC(10,2) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL,
  subtotal      NUMERIC(12,2) NOT NULL,
  descuento     NUMERIC(12,2) NOT NULL DEFAULT 0,

  modificadores JSONB NULL,
  curso         INTEGER NULL DEFAULT 1,

  combo_padre_id BIGINT NULL REFERENCES ventas_pos_items(id),
  es_combo_padre BOOLEAN NOT NULL DEFAULT FALSE,

  estado        TEXT NOT NULL DEFAULT 'hold'
                CHECK (estado IN ('hold', 'enviado', 'listo', 'entregado', 'anulado')),
  enviado_at    TIMESTAMPTZ NULL,
  listo_at      TIMESTAMPTZ NULL,
  anulado_at    TIMESTAMPTZ NULL,
  anulado_motivo TEXT NULL,

  notas         TEXT NULL,
  cargado_por   UUID NULL REFERENCES rrhh_empleados(id)
);
CREATE INDEX IF NOT EXISTS idx_vpi_venta
  ON ventas_pos_items(venta_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vpi_estado
  ON ventas_pos_items(local_id, estado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vpi_combo
  ON ventas_pos_items(combo_padre_id) WHERE combo_padre_id IS NOT NULL;
DROP TRIGGER IF EXISTS trg_vpi_set_updated_at ON ventas_pos_items;
CREATE TRIGGER trg_vpi_set_updated_at BEFORE UPDATE ON ventas_pos_items
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── ventas_pos_pagos ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ventas_pos_pagos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  version       INTEGER NOT NULL DEFAULT 1,

  venta_id      BIGINT NOT NULL REFERENCES ventas_pos(id),
  metodo        TEXT NOT NULL,
  monto         NUMERIC(12,2) NOT NULL,

  idempotency_key TEXT NOT NULL,
  vuelto        NUMERIC(12,2) NULL,
  propina_incluida NUMERIC(12,2) NOT NULL DEFAULT 0,

  cobrado_por   UUID NULL REFERENCES rrhh_empleados(id),

  estado        TEXT NOT NULL DEFAULT 'confirmado'
                CHECK (estado IN ('pendiente', 'confirmado', 'fallido', 'reembolsado')),
  confirmado_at TIMESTAMPTZ NULL,
  reembolsado_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_vpp_venta ON ventas_pos_pagos(venta_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vpp_idempotency
  ON ventas_pos_pagos(idempotency_key);
DROP TRIGGER IF EXISTS trg_vpp_set_updated_at ON ventas_pos_pagos;
CREATE TRIGGER trg_vpp_set_updated_at BEFORE UPDATE ON ventas_pos_pagos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── ventas_pos_overrides (inmutable) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ventas_pos_overrides (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  venta_id      BIGINT NOT NULL REFERENCES ventas_pos(id),
  venta_item_id BIGINT NULL REFERENCES ventas_pos_items(id),

  cajero_id     UUID NOT NULL REFERENCES rrhh_empleados(id),
  manager_id    UUID NOT NULL REFERENCES rrhh_empleados(id),

  accion        TEXT NOT NULL CHECK (accion IN (
    'void', 'comp', 'discount', 'refund', 'reopen',
    'transfer_table', 'cambio_mozo', 'merge_mesas', 'split_check'
  )),
  motivo        TEXT NOT NULL,
  valor_anterior NUMERIC(12,2) NULL,
  valor_nuevo    NUMERIC(12,2) NULL,
  monto_afectado NUMERIC(12,2) NULL,
  ip_origen     TEXT NULL,
  metadata      JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_vpo_venta ON ventas_pos_overrides(venta_id);
CREATE INDEX IF NOT EXISTS idx_vpo_manager
  ON ventas_pos_overrides(manager_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vpo_local_fecha
  ON ventas_pos_overrides(local_id, created_at DESC);

CREATE OR REPLACE FUNCTION fn_overrides_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ventas_pos_overrides es inmutable'; END;
$$;
DROP TRIGGER IF EXISTS trg_overrides_no_modify ON ventas_pos_overrides;
CREATE TRIGGER trg_overrides_no_modify
  BEFORE UPDATE OR DELETE ON ventas_pos_overrides
  FOR EACH ROW EXECUTE FUNCTION fn_overrides_immutable();

-- ─── metodos_cobro ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metodos_cobro (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,

  nombre        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  emoji         TEXT NULL,
  pide_vuelto   BOOLEAN NOT NULL DEFAULT FALSE,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  orden         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_metodos_cobro_slug
  ON metodos_cobro(tenant_id, COALESCE(local_id, 0), slug)
  WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_metodos_cobro_set_updated_at ON metodos_cobro;
CREATE TRIGGER trg_metodos_cobro_set_updated_at BEFORE UPDATE ON metodos_cobro
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── comanda_local_settings ────────────────────────────────────────────────
-- Datos extra del local que NO viven en `locales` (no podemos tocar PASE).
-- Slug público para tienda online + mp_qr_url + costo envío + redes.
CREATE TABLE IF NOT EXISTS comanda_local_settings (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  slug          TEXT NOT NULL,
  direccion     TEXT NULL,
  telefono      TEXT NULL,
  instagram     TEXT NULL,
  web           TEXT NULL,
  mp_qr_url     TEXT NULL,
  costo_envio_default NUMERIC(12,2) NOT NULL DEFAULT 0,
  tiempo_retiro_min   INTEGER NOT NULL DEFAULT 15,
  tiempo_delivery_min INTEGER NOT NULL DEFAULT 35,

  -- Tienda online activa (si false, /tienda/:slug responde "cerrada")
  tienda_activa BOOLEAN NOT NULL DEFAULT TRUE,
  acepta_delivery BOOLEAN NOT NULL DEFAULT TRUE,

  autolock_minutos INTEGER NOT NULL DEFAULT 3
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cls_local
  ON comanda_local_settings(local_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cls_slug
  ON comanda_local_settings(slug) WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_cls_set_updated_at ON comanda_local_settings;
CREATE TRIGGER trg_cls_set_updated_at BEFORE UPDATE ON comanda_local_settings
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- HISTORY TABLES + TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mesas_history (
  history_id  BIGSERIAL PRIMARY KEY,
  mesa_id     BIGINT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('UPDATE','DELETE')),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  INTEGER NULL REFERENCES usuarios(id),
  old_data    JSONB NOT NULL,
  new_data    JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_mesas_history_id
  ON mesas_history(mesa_id, changed_at DESC);
CREATE OR REPLACE FUNCTION fn_mesas_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO mesas_history (mesa_id, operation, changed_by, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mesas_audit ON mesas;
CREATE TRIGGER trg_mesas_audit AFTER UPDATE ON mesas
  FOR EACH ROW EXECUTE FUNCTION fn_mesas_audit();

CREATE TABLE IF NOT EXISTS turnos_caja_history (
  history_id  BIGSERIAL PRIMARY KEY,
  turno_id    BIGINT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('UPDATE','DELETE')),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  INTEGER NULL REFERENCES usuarios(id),
  old_data    JSONB NOT NULL,
  new_data    JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_turnos_caja_history_id
  ON turnos_caja_history(turno_id, changed_at DESC);
CREATE OR REPLACE FUNCTION fn_turnos_caja_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO turnos_caja_history (turno_id, operation, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_turnos_caja_audit ON turnos_caja;
CREATE TRIGGER trg_turnos_caja_audit AFTER UPDATE ON turnos_caja
  FOR EACH ROW EXECUTE FUNCTION fn_turnos_caja_audit();

CREATE TABLE IF NOT EXISTS ventas_pos_history (
  history_id  BIGSERIAL PRIMARY KEY,
  venta_id    BIGINT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('UPDATE','DELETE')),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  INTEGER NULL REFERENCES usuarios(id),
  old_data    JSONB NOT NULL,
  new_data    JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_ventas_pos_history_id
  ON ventas_pos_history(venta_id, changed_at DESC);
CREATE OR REPLACE FUNCTION fn_ventas_pos_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO ventas_pos_history (venta_id, operation, changed_by, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ventas_pos_audit ON ventas_pos;
CREATE TRIGGER trg_ventas_pos_audit AFTER UPDATE ON ventas_pos
  FOR EACH ROW EXECUTE FUNCTION fn_ventas_pos_audit();

CREATE TABLE IF NOT EXISTS ventas_pos_items_history (
  history_id  BIGSERIAL PRIMARY KEY,
  item_id     BIGINT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('UPDATE','DELETE')),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  INTEGER NULL REFERENCES usuarios(id),
  old_data    JSONB NOT NULL,
  new_data    JSONB NULL
);
CREATE INDEX IF NOT EXISTS idx_vpi_history_id
  ON ventas_pos_items_history(item_id, changed_at DESC);
CREATE OR REPLACE FUNCTION fn_vpi_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO ventas_pos_items_history (item_id, operation, changed_by, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_vpi_audit ON ventas_pos_items;
CREATE TRIGGER trg_vpi_audit AFTER UPDATE ON ventas_pos_items
  FOR EACH ROW EXECUTE FUNCTION fn_vpi_audit();

-- ═══════════════════════════════════════════════════════════════════════════
-- VISTA PÚBLICA (para tienda online sin login)
-- ═══════════════════════════════════════════════════════════════════════════
DROP VIEW IF EXISTS v_catalogo_publico;
CREATE VIEW v_catalogo_publico AS
SELECT i.id AS item_id,
       i.nombre,
       i.descripcion,
       i.emoji,
       i.foto_url,
       ipc.precio AS precio,
       ipc.canal_id,
       g.id AS grupo_id,
       g.nombre AS grupo_nombre,
       g.emoji AS grupo_emoji,
       cls.local_id,
       cls.slug AS local_slug
  FROM items i
  LEFT JOIN item_grupos g ON i.grupo_id = g.id AND g.deleted_at IS NULL
  INNER JOIN item_precios_canal ipc
    ON ipc.item_id = i.id AND ipc.deleted_at IS NULL AND ipc.vendible = TRUE
  INNER JOIN canales c
    ON ipc.canal_id = c.id AND c.deleted_at IS NULL AND c.activo = TRUE
       AND c.slug = 'tienda-propia'
  INNER JOIN comanda_local_settings cls
    ON cls.tenant_id = i.tenant_id
       AND (c.local_id IS NULL OR c.local_id = cls.local_id)
       AND cls.tienda_activa = TRUE
       AND cls.deleted_at IS NULL
 WHERE i.deleted_at IS NULL
   AND i.estado = 'disponible'
   AND i.visible_tienda = TRUE;

GRANT SELECT ON v_catalogo_publico TO anon;
GRANT SELECT ON v_catalogo_publico TO authenticated;

-- Vista pública de info del local (para que el cliente vea nombre, dir, redes)
DROP VIEW IF EXISTS v_locales_publicos;
CREATE VIEW v_locales_publicos AS
SELECT cls.local_id, cls.slug, l.nombre,
       cls.direccion, cls.telefono, cls.instagram, cls.web,
       cls.mp_qr_url, cls.costo_envio_default,
       cls.tiempo_retiro_min, cls.tiempo_delivery_min,
       cls.tienda_activa, cls.acepta_delivery
  FROM comanda_local_settings cls
  INNER JOIN locales l ON l.id = cls.local_id
 WHERE cls.deleted_at IS NULL AND cls.tienda_activa = TRUE;

GRANT SELECT ON v_locales_publicos TO anon;
GRANT SELECT ON v_locales_publicos TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- Helper: bypass de chequeo (superadmin/dueño no necesitan permiso explícito)
CREATE OR REPLACE FUNCTION fn_check_perm_comanda(p_slug TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth_es_superadmin() OR auth_es_dueno_o_admin() OR auth_tiene_permiso(p_slug);
$$;
GRANT EXECUTE ON FUNCTION fn_check_perm_comanda(TEXT) TO authenticated;

-- 1. Próximo número de ticket por local (correlativo eterno)
CREATE OR REPLACE FUNCTION fn_next_ticket_number_comanda(p_local_id INTEGER)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_next INTEGER;
BEGIN
  SELECT COALESCE(MAX(numero_local), 0) + 1 INTO v_next
    FROM ventas_pos WHERE local_id = p_local_id;
  RETURN v_next;
END;
$$;

-- 2. Abrir turno de caja (UNICO por local)
CREATE OR REPLACE FUNCTION fn_abrir_turno_caja_comanda(
  p_local_id INTEGER,
  p_cajero_id UUID,
  p_monto_inicial NUMERIC,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_turno_id BIGINT;
  v_numero INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.abrir') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_ABRIR';
  END IF;
  IF EXISTS (SELECT 1 FROM turnos_caja WHERE local_id = p_local_id AND estado = 'abierto') THEN
    RAISE EXCEPTION 'TURNO_YA_ABIERTO: ya hay un turno abierto en este local';
  END IF;

  SELECT COALESCE(MAX(numero), 0) + 1 INTO v_numero
    FROM turnos_caja WHERE local_id = p_local_id;

  INSERT INTO turnos_caja (
    tenant_id, local_id, numero, cajero_id, monto_inicial, notas, estado
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_cajero_id, p_monto_inicial, p_notas, 'abierto'
  ) RETURNING id INTO v_turno_id;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_cajero_id, 'apertura', p_monto_inicial, 'efectivo', 'Apertura de turno'
  );
  RETURN v_turno_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_abrir_turno_caja_comanda(INTEGER, UUID, NUMERIC, TEXT) TO authenticated;

-- 3. Movimiento de caja (retiro/depósito/ajuste)
CREATE OR REPLACE FUNCTION fn_movimiento_caja_comanda(
  p_local_id INTEGER,
  p_empleado_id UUID,
  p_tipo TEXT,
  p_monto NUMERIC,
  p_metodo TEXT,
  p_motivo TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_turno_id BIGINT;
  v_mov_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.movimientos') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_MOVIMIENTOS';
  END IF;
  IF p_tipo NOT IN ('retiro','deposito','ajuste') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;
  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;
  IF v_turno_id IS NULL THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;
  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo
  ) VALUES (
    auth_tenant_id(), p_local_id, v_turno_id, p_empleado_id, p_tipo, p_monto, p_metodo, p_motivo
  ) RETURNING id INTO v_mov_id;
  RETURN v_mov_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_movimiento_caja_comanda(INTEGER, UUID, TEXT, NUMERIC, TEXT, TEXT) TO authenticated;

-- 4. Cerrar turno de caja con arqueo
CREATE OR REPLACE FUNCTION fn_cerrar_turno_caja_comanda(
  p_turno_id BIGINT,
  p_cerrado_por UUID,
  p_monto_final_declarado NUMERIC,
  p_notas TEXT DEFAULT NULL
) RETURNS TABLE(
  monto_calculado NUMERIC,
  diferencia NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_calculado NUMERIC;
  v_local_id INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.caja.cerrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_CAJA_CERRAR';
  END IF;

  SELECT local_id INTO v_local_id FROM turnos_caja WHERE id = p_turno_id AND estado = 'abierto';
  IF v_local_id IS NULL THEN
    RAISE EXCEPTION 'TURNO_NO_ENCONTRADO_O_CERRADO';
  END IF;

  -- Saldo en efectivo: apertura + ventas efectivo + depósitos - retiros
  SELECT COALESCE(SUM(
    CASE
      WHEN tipo IN ('apertura','venta','deposito','ajuste') THEN monto
      WHEN tipo IN ('retiro','venta_anulada') THEN -monto
      ELSE 0
    END
  ), 0) INTO v_calculado
    FROM movimientos_caja
   WHERE turno_caja_id = p_turno_id AND metodo = 'efectivo';

  UPDATE turnos_caja SET
    estado = 'cerrado',
    cerrado_at = NOW(),
    cerrado_por = p_cerrado_por,
    monto_final_declarado = p_monto_final_declarado,
    monto_final_calculado = v_calculado,
    diferencia = p_monto_final_declarado - v_calculado,
    notas = COALESCE(notas, '') || COALESCE(E'\n--cierre--\n' || p_notas, '')
  WHERE id = p_turno_id;

  INSERT INTO movimientos_caja (
    tenant_id, local_id, turno_caja_id, empleado_id, tipo, monto, metodo, motivo
  ) VALUES (
    auth_tenant_id(), v_local_id, p_turno_id, p_cerrado_por, 'cierre',
    p_monto_final_declarado, 'efectivo', 'Cierre de turno (declarado)'
  );

  RETURN QUERY SELECT v_calculado, p_monto_final_declarado - v_calculado;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_cerrar_turno_caja_comanda(BIGINT, UUID, NUMERIC, TEXT) TO authenticated;

-- 5. Abrir venta
CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda(
  p_local_id INTEGER,
  p_modo TEXT,
  p_canal_id INTEGER,
  p_mesa_id BIGINT DEFAULT NULL,
  p_mozo_id UUID DEFAULT NULL,
  p_cajero_id UUID DEFAULT NULL,
  p_cliente_nombre TEXT DEFAULT NULL,
  p_cliente_telefono TEXT DEFAULT NULL,
  p_cliente_direccion TEXT DEFAULT NULL,
  p_covers INTEGER DEFAULT NULL,
  p_origen TEXT DEFAULT 'pos',
  p_tipo_entrega TEXT DEFAULT NULL,
  p_estado TEXT DEFAULT 'abierta'
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id BIGINT;
  v_numero INTEGER;
  v_turno_id BIGINT;
BEGIN
  IF p_origen = 'pos' AND NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  IF v_turno_id IS NULL AND p_origen = 'pos' AND p_modo != 'pedidos' THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;

  v_numero := fn_next_ticket_number_comanda(p_local_id);

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id, turno_caja_id,
    mesa_id, mozo_id, cajero_id, cliente_nombre, cliente_telefono,
    cliente_direccion, covers, origen, tipo_entrega, estado
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_modo, p_canal_id, v_turno_id,
    p_mesa_id, p_mozo_id, p_cajero_id, p_cliente_nombre, p_cliente_telefono,
    p_cliente_direccion, p_covers, p_origen, p_tipo_entrega, p_estado
  ) RETURNING id INTO v_id;

  IF p_mesa_id IS NOT NULL AND p_estado = 'abierta' THEN
    UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_id AND estado = 'libre';
  END IF;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_abrir_venta_comanda(
  INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT
) TO authenticated;

-- Helper interno: recalcular totales de venta
CREATE OR REPLACE FUNCTION fn_recalc_total_venta(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_subtotal NUMERIC;
BEGIN
  SELECT COALESCE(SUM(subtotal - descuento), 0) INTO v_subtotal
    FROM ventas_pos_items
   WHERE venta_id = p_venta_id AND deleted_at IS NULL AND estado != 'anulado';
  UPDATE ventas_pos SET
    subtotal = v_subtotal,
    total = v_subtotal - descuento_total + propina,
    updated_at = NOW()
  WHERE id = p_venta_id;
END;
$$;

-- 6. Agregar item a venta
CREATE OR REPLACE FUNCTION fn_agregar_item_comanda(
  p_venta_id BIGINT,
  p_item_id INTEGER,
  p_cantidad NUMERIC,
  p_curso INTEGER DEFAULT 1,
  p_modificadores JSONB DEFAULT NULL,
  p_notas TEXT DEFAULT NULL,
  p_cargado_por UUID DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id BIGINT;
  v_local_id INTEGER;
  v_canal_id INTEGER;
  v_estado TEXT;
  v_precio NUMERIC;
  v_extras NUMERIC := 0;
  v_subtotal NUMERIC;
  v_mod JSONB;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, canal_id, estado INTO v_local_id, v_canal_id, v_estado
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_estado IN ('cobrada','anulada') THEN
    RAISE EXCEPTION 'VENTA_NO_EDITABLE: estado %', v_estado;
  END IF;

  -- Tomar precio del canal de la venta; fallback a precio_madre
  SELECT precio INTO v_precio
    FROM item_precios_canal
   WHERE item_id = p_item_id AND canal_id = v_canal_id AND deleted_at IS NULL
   LIMIT 1;
  IF v_precio IS NULL THEN
    SELECT precio_madre INTO v_precio FROM items WHERE id = p_item_id;
  END IF;
  IF v_precio IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  -- Sumar precio_extra de modificadores (JSONB array de {nombre, precio_extra})
  IF p_modificadores IS NOT NULL THEN
    FOR v_mod IN SELECT * FROM jsonb_array_elements(p_modificadores) LOOP
      v_extras := v_extras + COALESCE((v_mod->>'precio_extra')::NUMERIC, 0);
    END LOOP;
  END IF;

  v_subtotal := (v_precio + v_extras) * p_cantidad;

  INSERT INTO ventas_pos_items (
    tenant_id, local_id, venta_id, item_id, cantidad, precio_unitario,
    subtotal, modificadores, curso, notas, cargado_por
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, p_item_id, p_cantidad,
    v_precio + v_extras, v_subtotal, p_modificadores, p_curso, p_notas, p_cargado_por
  ) RETURNING id INTO v_id;

  PERFORM fn_recalc_total_venta(p_venta_id);
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_agregar_item_comanda(BIGINT, INTEGER, NUMERIC, INTEGER, JSONB, TEXT, UUID) TO authenticated;

-- 7. Modificar item (cantidad / curso / notas)
CREATE OR REPLACE FUNCTION fn_modificar_item_comanda(
  p_item_id BIGINT,
  p_cantidad NUMERIC DEFAULT NULL,
  p_curso INTEGER DEFAULT NULL,
  p_notas TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_venta_id BIGINT;
  v_pu NUMERIC;
  v_estado TEXT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT venta_id, precio_unitario, estado INTO v_venta_id, v_pu, v_estado
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;
  IF v_estado IN ('enviado','listo','entregado','anulado') THEN
    RAISE EXCEPTION 'ITEM_NO_EDITABLE: estado %', v_estado;
  END IF;

  UPDATE ventas_pos_items SET
    cantidad = COALESCE(p_cantidad, cantidad),
    subtotal = COALESCE(p_cantidad, cantidad) * v_pu,
    curso    = COALESCE(p_curso, curso),
    notas    = COALESCE(p_notas, notas),
    updated_at = NOW()
  WHERE id = p_item_id;

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;
GRANT EXECUTE ON FUNCTION fn_modificar_item_comanda(BIGINT, NUMERIC, INTEGER, TEXT) TO authenticated;

-- 8. Anular item (con manager override)
CREATE OR REPLACE FUNCTION fn_anular_item_comanda(
  p_item_id BIGINT,
  p_manager_id UUID,
  p_motivo TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_venta_id BIGINT;
  v_local_id INTEGER;
  v_subtotal NUMERIC;
  v_cajero UUID;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
  ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;

  SELECT venta_id, local_id, subtotal INTO v_venta_id, v_local_id, v_subtotal
    FROM ventas_pos_items WHERE id = p_item_id AND deleted_at IS NULL;
  IF v_venta_id IS NULL THEN RAISE EXCEPTION 'ITEM_NO_ENCONTRADO'; END IF;

  SELECT cajero_id INTO v_cajero FROM ventas_pos WHERE id = v_venta_id;

  UPDATE ventas_pos_items SET
    estado = 'anulado',
    anulado_at = NOW(),
    anulado_motivo = p_motivo,
    updated_at = NOW()
  WHERE id = p_item_id;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, venta_item_id,
    cajero_id, manager_id, accion, motivo, monto_afectado
  ) VALUES (
    auth_tenant_id(), v_local_id, v_venta_id, p_item_id,
    COALESCE(v_cajero, p_manager_id), p_manager_id, 'void', p_motivo, v_subtotal
  );

  PERFORM fn_recalc_total_venta(v_venta_id);
END;
$$;
GRANT EXECUTE ON FUNCTION fn_anular_item_comanda(BIGINT, UUID, TEXT) TO authenticated;

-- 9. Mandar curso (items hold → enviado)
CREATE OR REPLACE FUNCTION fn_mandar_curso_comanda(
  p_venta_id BIGINT,
  p_curso INTEGER
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count INTEGER;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;
  UPDATE ventas_pos_items SET
    estado = 'enviado', enviado_at = NOW(), updated_at = NOW()
  WHERE venta_id = p_venta_id AND curso = p_curso
    AND estado = 'hold' AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    UPDATE ventas_pos SET
      estado = CASE WHEN estado = 'abierta' THEN 'enviada' ELSE estado END,
      enviada_at = COALESCE(enviada_at, NOW()),
      updated_at = NOW()
    WHERE id = p_venta_id;
  END IF;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_mandar_curso_comanda(BIGINT, INTEGER) TO authenticated;

-- 10. Aplicar descuento a venta (con manager override si supera 15%)
CREATE OR REPLACE FUNCTION fn_aplicar_descuento_comanda(
  p_venta_id BIGINT,
  p_monto NUMERIC,
  p_motivo TEXT,
  p_manager_id UUID DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_subtotal NUMERIC;
  v_local_id INTEGER;
  v_cajero UUID;
  v_pct NUMERIC;
  v_anterior NUMERIC;
BEGIN
  SELECT subtotal, local_id, cajero_id, descuento_total INTO v_subtotal, v_local_id, v_cajero, v_anterior
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  v_pct := CASE WHEN v_subtotal > 0 THEN p_monto / v_subtotal * 100 ELSE 0 END;

  IF v_pct > 15 THEN
    -- Necesita manager override
    IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO_DESCUENTO_GRANDE'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rrhh_empleados
       WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
    ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;
  ELSE
    IF NOT fn_check_perm_comanda('comanda.ventas.descuento') THEN
      RAISE EXCEPTION 'SIN_PERMISO_DESCUENTO';
    END IF;
  END IF;

  UPDATE ventas_pos SET
    descuento_total = p_monto, updated_at = NOW()
  WHERE id = p_venta_id;
  PERFORM fn_recalc_total_venta(p_venta_id);

  IF p_manager_id IS NOT NULL THEN
    INSERT INTO ventas_pos_overrides (
      tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
      valor_anterior, valor_nuevo, monto_afectado
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
      p_manager_id, 'discount', p_motivo, v_anterior, p_monto, p_monto
    );
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_aplicar_descuento_comanda(BIGINT, NUMERIC, TEXT, UUID) TO authenticated;

-- 11. Cobrar venta (multi-pago, idempotente)
CREATE OR REPLACE FUNCTION fn_cobrar_venta_comanda(
  p_venta_id BIGINT,
  p_pagos JSONB,                -- [{metodo, monto, idempotency_key, vuelto?}]
  p_propina NUMERIC DEFAULT 0,
  p_cobrado_por UUID DEFAULT NULL
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER;
  v_estado TEXT;
  v_total NUMERIC;
  v_subtotal NUMERIC;
  v_descuento NUMERIC;
  v_suma_pagos NUMERIC := 0;
  v_pago JSONB;
  v_turno_id BIGINT;
  v_mesa_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.ventas.cobrar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT local_id, estado, subtotal, descuento_total, turno_caja_id, mesa_id
    INTO v_local_id, v_estado, v_subtotal, v_descuento, v_turno_id, v_mesa_id
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;
  IF v_estado = 'cobrada' THEN RAISE EXCEPTION 'VENTA_YA_COBRADA'; END IF;
  IF v_estado = 'anulada' THEN RAISE EXCEPTION 'VENTA_ANULADA'; END IF;

  v_total := v_subtotal - v_descuento + COALESCE(p_propina, 0);

  -- Validar suma == total
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    v_suma_pagos := v_suma_pagos + COALESCE((v_pago->>'monto')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_suma_pagos - v_total) > 0.01 THEN
    RAISE EXCEPTION 'SUMA_PAGOS_NO_COINCIDE: suma=% total=%', v_suma_pagos, v_total;
  END IF;

  -- Insertar pagos (idempotency_key UNIQUE atómico)
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO ventas_pos_pagos (
      tenant_id, local_id, venta_id, metodo, monto, idempotency_key,
      vuelto, propina_incluida, cobrado_por, estado, confirmado_at
    ) VALUES (
      auth_tenant_id(), v_local_id, p_venta_id,
      v_pago->>'metodo',
      (v_pago->>'monto')::NUMERIC,
      v_pago->>'idempotency_key',
      NULLIF((v_pago->>'vuelto'),'')::NUMERIC,
      COALESCE((v_pago->>'propina_incluida')::NUMERIC, 0),
      p_cobrado_por,
      'confirmado',
      NOW()
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  -- Actualizar venta
  UPDATE ventas_pos SET
    estado = 'cobrada', propina = COALESCE(p_propina, 0),
    cobrada_at = NOW(),
    total = v_total,
    updated_at = NOW()
  WHERE id = p_venta_id;

  -- Liberar mesa
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  -- Movimiento de caja por pago (1 por método)
  IF v_turno_id IS NOT NULL THEN
    FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
      INSERT INTO movimientos_caja (
        tenant_id, local_id, turno_caja_id, empleado_id, tipo,
        monto, metodo, motivo, venta_id
      ) VALUES (
        auth_tenant_id(), v_local_id, v_turno_id, COALESCE(p_cobrado_por,
          (SELECT cajero_id FROM turnos_caja WHERE id = v_turno_id)),
        'venta', (v_pago->>'monto')::NUMERIC, v_pago->>'metodo',
        'Cobro venta #' || p_venta_id, p_venta_id
      );
    END LOOP;
  END IF;

  RETURN v_total;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_cobrar_venta_comanda(BIGINT, JSONB, NUMERIC, UUID) TO authenticated;

-- 12. Anular venta entera (con manager override)
CREATE OR REPLACE FUNCTION fn_anular_venta_comanda(
  p_venta_id BIGINT, p_manager_id UUID, p_motivo TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_mesa_id BIGINT;
  v_cajero UUID;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_manager_id AND rol_pos IN ('manager','dueno') AND pos_activo = TRUE
  ) THEN RAISE EXCEPTION 'MANAGER_INVALIDO'; END IF;

  SELECT local_id, total, mesa_id, cajero_id
    INTO v_local_id, v_total, v_mesa_id, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  UPDATE ventas_pos SET estado = 'anulada', anulada_at = NOW(), updated_at = NOW()
   WHERE id = p_venta_id;
  UPDATE ventas_pos_items SET estado = 'anulado', anulado_at = NOW(), updated_at = NOW()
   WHERE venta_id = p_venta_id AND estado != 'anulado';
  IF v_mesa_id IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_id;
  END IF;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
    p_manager_id, 'void', p_motivo, v_total
  );
END;
$$;
GRANT EXECUTE ON FUNCTION fn_anular_venta_comanda(BIGINT, UUID, TEXT) TO authenticated;

-- 13. Reabrir venta cobrada (manager override)
CREATE OR REPLACE FUNCTION fn_reabrir_venta_comanda(
  p_venta_id BIGINT, p_manager_id UUID, p_motivo TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_cajero UUID;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  SELECT local_id, total, cajero_id INTO v_local_id, v_total, v_cajero
    FROM ventas_pos WHERE id = p_venta_id AND estado = 'cobrada';
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_REOPEN'; END IF;

  UPDATE ventas_pos SET estado = 'enviada', cobrada_at = NULL, updated_at = NOW()
   WHERE id = p_venta_id;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
    p_manager_id, 'reopen', p_motivo, v_total
  );
END;
$$;
GRANT EXECUTE ON FUNCTION fn_reabrir_venta_comanda(BIGINT, UUID, TEXT) TO authenticated;

-- 14. Refund (reembolso de pagos confirmados)
CREATE OR REPLACE FUNCTION fn_refund_venta_comanda(
  p_venta_id BIGINT, p_manager_id UUID, p_motivo TEXT
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER;
  v_total NUMERIC;
  v_cajero UUID;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  SELECT local_id, total, cajero_id INTO v_local_id, v_total, v_cajero
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  UPDATE ventas_pos_pagos SET
    estado = 'reembolsado', reembolsado_at = NOW(), updated_at = NOW()
  WHERE venta_id = p_venta_id AND estado = 'confirmado';

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo, monto_afectado
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, COALESCE(v_cajero, p_manager_id),
    p_manager_id, 'refund', p_motivo, v_total
  );
  RETURN v_total;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_refund_venta_comanda(BIGINT, UUID, TEXT) TO authenticated;

-- 15. Transferir mesa (cambiar mesa de una venta)
CREATE OR REPLACE FUNCTION fn_transferir_mesa_comanda(
  p_venta_id BIGINT, p_mesa_destino BIGINT, p_manager_id UUID, p_motivo TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER; v_mesa_origen BIGINT;
BEGIN
  IF p_manager_id IS NULL THEN RAISE EXCEPTION 'MANAGER_REQUERIDO'; END IF;
  SELECT local_id, mesa_id INTO v_local_id, v_mesa_origen
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'VENTA_NO_ENCONTRADA'; END IF;

  UPDATE ventas_pos SET mesa_id = p_mesa_destino, updated_at = NOW()
   WHERE id = p_venta_id;
  IF v_mesa_origen IS NOT NULL THEN
    UPDATE mesas SET estado = 'libre' WHERE id = v_mesa_origen;
  END IF;
  UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_destino;

  INSERT INTO ventas_pos_overrides (
    tenant_id, local_id, venta_id, cajero_id, manager_id, accion, motivo,
    metadata
  ) VALUES (
    auth_tenant_id(), v_local_id, p_venta_id, p_manager_id, p_manager_id,
    'transfer_table', p_motivo,
    jsonb_build_object('mesa_origen', v_mesa_origen, 'mesa_destino', p_mesa_destino)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION fn_transferir_mesa_comanda(BIGINT, BIGINT, UUID, TEXT) TO authenticated;

-- 16. Aprobar pedido tienda online
CREATE OR REPLACE FUNCTION fn_aprobar_pedido_comanda(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER; v_estado TEXT; v_turno_id BIGINT;
BEGIN
  IF NOT fn_check_perm_comanda('comanda.tienda.aprobar') THEN
    RAISE EXCEPTION 'SIN_PERMISO_APROBAR';
  END IF;
  SELECT local_id, estado INTO v_local_id, v_estado
    FROM ventas_pos WHERE id = p_venta_id;
  IF v_estado != 'necesita_aprobacion' THEN
    RAISE EXCEPTION 'PEDIDO_NO_PENDIENTE';
  END IF;
  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = v_local_id AND estado = 'abierto' LIMIT 1;
  UPDATE ventas_pos SET
    estado = 'enviada', enviada_at = NOW(), turno_caja_id = v_turno_id, updated_at = NOW()
  WHERE id = p_venta_id;
  UPDATE ventas_pos_items SET estado = 'enviado', enviado_at = NOW()
   WHERE venta_id = p_venta_id AND estado = 'hold';
END;
$$;
GRANT EXECUTE ON FUNCTION fn_aprobar_pedido_comanda(BIGINT) TO authenticated;

-- 17. Marcar venta lista (cocina terminó)
CREATE OR REPLACE FUNCTION fn_marcar_listo_comanda(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE ventas_pos SET estado = 'lista', updated_at = NOW()
   WHERE id = p_venta_id AND estado IN ('enviada', 'abierta');
  UPDATE ventas_pos_items SET estado = 'listo', listo_at = NOW()
   WHERE venta_id = p_venta_id AND estado = 'enviado';
END;
$$;
GRANT EXECUTE ON FUNCTION fn_marcar_listo_comanda(BIGINT) TO authenticated;

-- 18. Marcar entregado
CREATE OR REPLACE FUNCTION fn_marcar_entregado_comanda(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE ventas_pos SET estado = 'entregada', updated_at = NOW()
   WHERE id = p_venta_id AND estado IN ('lista', 'enviada');
  UPDATE ventas_pos_items SET estado = 'entregado'
   WHERE venta_id = p_venta_id AND estado IN ('listo','enviado');
END;
$$;
GRANT EXECUTE ON FUNCTION fn_marcar_entregado_comanda(BIGINT) TO authenticated;

-- 19. Crear pedido público (anon, viene de la tienda online)
-- Recibe: local_slug, datos cliente, items (JSONB array), metodo_pago_preferido
-- Crea venta con estado='necesita_aprobacion', origen='tienda_online'.
CREATE OR REPLACE FUNCTION fn_crear_pedido_publico_comanda(
  p_local_slug TEXT,
  p_cliente_nombre TEXT,
  p_cliente_telefono TEXT,
  p_cliente_email TEXT,
  p_tipo_entrega TEXT,
  p_cliente_direccion TEXT,
  p_items JSONB,                  -- [{item_id, cantidad, modificadores?, notas?}]
  p_metodo_pago_preferido TEXT,
  p_notas TEXT DEFAULT NULL
) RETURNS TABLE (venta_id BIGINT, numero_local INTEGER) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_local_id INTEGER;
  v_tenant_id UUID;
  v_canal_id INTEGER;
  v_venta_id BIGINT;
  v_numero INTEGER;
  v_item JSONB;
  v_pre NUMERIC;
  v_extras NUMERIC;
  v_qty NUMERIC;
  v_mod JSONB;
  v_acepta_delivery BOOLEAN;
BEGIN
  -- Resolver local
  SELECT cls.local_id, cls.tenant_id, cls.acepta_delivery
    INTO v_local_id, v_tenant_id, v_acepta_delivery
    FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug AND cls.tienda_activa = TRUE AND cls.deleted_at IS NULL;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;

  IF p_tipo_entrega = 'delivery' AND NOT v_acepta_delivery THEN
    RAISE EXCEPTION 'LOCAL_NO_ACEPTA_DELIVERY';
  END IF;
  IF p_tipo_entrega NOT IN ('retiro','delivery') THEN
    RAISE EXCEPTION 'TIPO_ENTREGA_INVALIDO';
  END IF;

  -- Resolver canal "tienda-propia" del local (o global del tenant)
  SELECT id INTO v_canal_id FROM canales
   WHERE tenant_id = v_tenant_id AND slug = 'tienda-propia'
     AND deleted_at IS NULL AND activo = TRUE
     AND (local_id IS NULL OR local_id = v_local_id)
   ORDER BY local_id NULLS LAST
   LIMIT 1;
  IF v_canal_id IS NULL THEN RAISE EXCEPTION 'CANAL_TIENDA_NO_CONFIGURADO'; END IF;

  -- Próximo número
  SELECT COALESCE(MAX(numero_local), 0) + 1 INTO v_numero
    FROM ventas_pos WHERE local_id = v_local_id;

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id,
    cliente_nombre, cliente_telefono, cliente_direccion,
    estado, origen, tipo_entrega, notas
  ) VALUES (
    v_tenant_id, v_local_id, v_numero, 'pedidos', v_canal_id,
    p_cliente_nombre, p_cliente_telefono, p_cliente_direccion,
    'necesita_aprobacion', 'tienda_online', p_tipo_entrega,
    COALESCE(p_notas, '') ||
    CASE WHEN p_cliente_email IS NOT NULL THEN E'\nemail: ' || p_cliente_email ELSE '' END ||
    E'\nmetodo_preferido: ' || COALESCE(p_metodo_pago_preferido,'no especificado')
  ) RETURNING id INTO v_venta_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'cantidad')::NUMERIC, 1);
    SELECT precio INTO v_pre FROM item_precios_canal
     WHERE item_id = (v_item->>'item_id')::INTEGER AND canal_id = v_canal_id
       AND deleted_at IS NULL LIMIT 1;
    IF v_pre IS NULL THEN
      SELECT precio_madre INTO v_pre FROM items
       WHERE id = (v_item->>'item_id')::INTEGER;
    END IF;
    IF v_pre IS NULL THEN RAISE EXCEPTION 'ITEM_NO_DISPONIBLE'; END IF;

    v_extras := 0;
    IF v_item ? 'modificadores' THEN
      FOR v_mod IN SELECT * FROM jsonb_array_elements(v_item->'modificadores') LOOP
        v_extras := v_extras + COALESCE((v_mod->>'precio_extra')::NUMERIC, 0);
      END LOOP;
    END IF;

    INSERT INTO ventas_pos_items (
      tenant_id, local_id, venta_id, item_id, cantidad,
      precio_unitario, subtotal, modificadores, curso, notas, estado
    ) VALUES (
      v_tenant_id, v_local_id, v_venta_id, (v_item->>'item_id')::INTEGER, v_qty,
      v_pre + v_extras, (v_pre + v_extras) * v_qty,
      v_item->'modificadores', 1, v_item->>'notas', 'hold'
    );
  END LOOP;

  PERFORM fn_recalc_total_venta(v_venta_id);

  RETURN QUERY SELECT v_venta_id, v_numero;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_crear_pedido_publico_comanda(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT
) TO anon;
GRANT EXECUTE ON FUNCTION fn_crear_pedido_publico_comanda(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT
) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS (patrón canónico PASE)
-- ═══════════════════════════════════════════════════════════════════════════

-- Macros ayuda: aplicar tabla por tabla.
-- Tablas con soft delete (filtran deleted_at IS NULL en SELECT)
DO $$
DECLARE
  t TEXT;
  perm TEXT;
  tabla_perm TEXT[][] := ARRAY[
    ['mesas',                 'comanda.mesas.gestionar'],
    ['ventas_pos',            'comanda.ventas.cobrar'],
    ['ventas_pos_items',      'comanda.ventas.cobrar'],
    ['ventas_pos_pagos',      'comanda.ventas.cobrar'],
    ['metodos_cobro',         'comanda.config.editar'],
    ['comanda_local_settings','comanda.config.editar']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1..array_length(tabla_perm, 1) LOOP
    t := tabla_perm[i][1];
    perm := tabla_perm[i][2];
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_select ON %I FOR SELECT TO authenticated
      USING (
        deleted_at IS NULL AND (
          auth_es_superadmin() OR (
            tenant_id = auth_tenant_id() AND
            (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
          )
        )
      )
    $f$, t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_write ON %I FOR ALL TO authenticated
      USING (
        auth_es_superadmin() OR (
          tenant_id = auth_tenant_id() AND
          (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
          auth_tiene_permiso(%L)
        )
      )
      WITH CHECK (
        auth_es_superadmin() OR (
          tenant_id = auth_tenant_id() AND
          (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
          auth_tiene_permiso(%L)
        )
      )
    $f$, t, t, perm, perm);
  END LOOP;
END $$;

-- Tablas sin soft delete (turnos_caja, movimientos_caja) — append-only
DO $$
DECLARE
  t TEXT;
  perm TEXT;
  tabla_perm TEXT[][] := ARRAY[
    ['turnos_caja',           'comanda.caja.abrir'],
    ['movimientos_caja',      'comanda.caja.movimientos']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1..array_length(tabla_perm, 1) LOOP
    t := tabla_perm[i][1];
    perm := tabla_perm[i][2];
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_select ON %I FOR SELECT TO authenticated
      USING (
        auth_es_superadmin() OR (
          tenant_id = auth_tenant_id() AND
          (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
        )
      )
    $f$, t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_write ON %I FOR ALL TO authenticated
      USING (
        auth_es_superadmin() OR (
          tenant_id = auth_tenant_id() AND
          (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())) AND
          auth_tiene_permiso(%L)
        )
      )
      WITH CHECK (
        auth_es_superadmin() OR (
          tenant_id = auth_tenant_id() AND
          (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())) AND
          auth_tiene_permiso(%L)
        )
      )
    $f$, t, t, perm, perm);
  END LOOP;
END $$;

-- ventas_pos_overrides: SELECT abierto para los del tenant (auditoría visible),
-- INSERT vía RPCs (security definer); UPDATE/DELETE bloqueados por trigger.
ALTER TABLE ventas_pos_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vpo_select ON ventas_pos_overrides;
CREATE POLICY vpo_select ON ventas_pos_overrides FOR SELECT TO authenticated USING (
  auth_es_superadmin() OR (
    tenant_id = auth_tenant_id() AND
    (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
);
DROP POLICY IF EXISTS vpo_insert ON ventas_pos_overrides;
CREATE POLICY vpo_insert ON ventas_pos_overrides FOR INSERT TO authenticated WITH CHECK (
  auth_es_superadmin() OR tenant_id = auth_tenant_id()
);

-- History tables: solo SELECT para todo el tenant
DO $$
DECLARE
  t TEXT;
  hist TEXT[] := ARRAY['mesas_history', 'turnos_caja_history', 'ventas_pos_history', 'ventas_pos_items_history'];
  i INTEGER;
BEGIN
  FOR i IN 1..array_length(hist, 1) LOOP
    t := hist[i];
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_select ON %I FOR SELECT TO authenticated
      USING (auth_es_superadmin() OR auth_es_dueno_o_admin())
    $f$, t, t);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEEDS
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_tenant UUID;
  v_local RECORD;
  v_slug TEXT;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'TENANT_NEKO_NOT_FOUND'; END IF;

  -- ─── Métodos de cobro ──
  INSERT INTO metodos_cobro (tenant_id, nombre, slug, emoji, pide_vuelto, orden)
  SELECT v_tenant, 'Efectivo', 'efectivo', '💵', TRUE, 1
  WHERE NOT EXISTS (SELECT 1 FROM metodos_cobro WHERE tenant_id=v_tenant AND slug='efectivo' AND local_id IS NULL AND deleted_at IS NULL);

  INSERT INTO metodos_cobro (tenant_id, nombre, slug, emoji, pide_vuelto, orden)
  SELECT v_tenant, 'Tarjeta Débito', 'tarjeta_debito', '💳', FALSE, 2
  WHERE NOT EXISTS (SELECT 1 FROM metodos_cobro WHERE tenant_id=v_tenant AND slug='tarjeta_debito' AND local_id IS NULL AND deleted_at IS NULL);

  INSERT INTO metodos_cobro (tenant_id, nombre, slug, emoji, pide_vuelto, orden)
  SELECT v_tenant, 'Tarjeta Crédito', 'tarjeta_credito', '💳', FALSE, 3
  WHERE NOT EXISTS (SELECT 1 FROM metodos_cobro WHERE tenant_id=v_tenant AND slug='tarjeta_credito' AND local_id IS NULL AND deleted_at IS NULL);

  INSERT INTO metodos_cobro (tenant_id, nombre, slug, emoji, pide_vuelto, orden)
  SELECT v_tenant, 'MercadoPago QR', 'mp_qr', '📱', FALSE, 4
  WHERE NOT EXISTS (SELECT 1 FROM metodos_cobro WHERE tenant_id=v_tenant AND slug='mp_qr' AND local_id IS NULL AND deleted_at IS NULL);

  INSERT INTO metodos_cobro (tenant_id, nombre, slug, emoji, pide_vuelto, orden)
  SELECT v_tenant, 'Transferencia', 'transferencia', '🏦', FALSE, 5
  WHERE NOT EXISTS (SELECT 1 FROM metodos_cobro WHERE tenant_id=v_tenant AND slug='transferencia' AND local_id IS NULL AND deleted_at IS NULL);

  INSERT INTO metodos_cobro (tenant_id, nombre, slug, emoji, pide_vuelto, orden)
  SELECT v_tenant, 'Otros', 'otros', '📝', FALSE, 6
  WHERE NOT EXISTS (SELECT 1 FROM metodos_cobro WHERE tenant_id=v_tenant AND slug='otros' AND local_id IS NULL AND deleted_at IS NULL);

  -- ─── comanda_local_settings + mesas por local ──
  FOR v_local IN
    SELECT id, nombre FROM locales WHERE tenant_id = v_tenant ORDER BY id
  LOOP
    -- Slug: lowercase, sin acentos, espacios→guiones, sacar prefix "neko-"
    v_slug := regexp_replace(
      lower(fn_unaccent_immutable(v_local.nombre)),
      '[^a-z0-9]+', '-', 'g'
    );
    v_slug := regexp_replace(v_slug, '^neko-', '', '');
    v_slug := regexp_replace(v_slug, '^-+|-+$', '', 'g');

    -- Resolver colisiones de slug agregando id
    IF EXISTS (SELECT 1 FROM comanda_local_settings WHERE slug = v_slug AND deleted_at IS NULL AND local_id != v_local.id) THEN
      v_slug := v_slug || '-' || v_local.id;
    END IF;

    INSERT INTO comanda_local_settings (tenant_id, local_id, slug)
    VALUES (v_tenant, v_local.id, v_slug)
    ON CONFLICT DO NOTHING;

    -- Mesas por local: VC=15+5+6, Belgrano=12+6+4, otros=5+0+0
    IF v_local.nombre ILIKE '%villa crespo%' THEN
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, n::TEXT, 'Salón', 4, 'cuadrado'
        FROM generate_series(1, 15) n
      ON CONFLICT DO NOTHING;
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, n::TEXT, 'Terraza', 4, 'redondo'
        FROM generate_series(16, 20) n
      ON CONFLICT DO NOTHING;
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, 'B' || n, 'Barra', 1, 'cuadrado'
        FROM generate_series(1, 6) n
      ON CONFLICT DO NOTHING;

    ELSIF v_local.nombre ILIKE '%belgrano%' THEN
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, n::TEXT, 'Salón', 4, 'cuadrado'
        FROM generate_series(1, 12) n
      ON CONFLICT DO NOTHING;
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, n::TEXT, 'Terraza', 4, 'redondo'
        FROM generate_series(13, 18) n
      ON CONFLICT DO NOTHING;
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, 'B' || n, 'Barra', 1, 'cuadrado'
        FROM generate_series(1, 4) n
      ON CONFLICT DO NOTHING;

    ELSE
      INSERT INTO mesas (tenant_id, local_id, numero, zona, capacidad, forma)
      SELECT v_tenant, v_local.id, n::TEXT, 'Salón', 4, 'cuadrado'
        FROM generate_series(1, 5) n
      ON CONFLICT DO NOTHING;
    END IF;

  END LOOP;

  RAISE NOTICE 'COMANDA Sprint 2 seeds aplicados sobre tenant=%', v_tenant;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN COMANDA Sprint 2
-- ═══════════════════════════════════════════════════════════════════════════
