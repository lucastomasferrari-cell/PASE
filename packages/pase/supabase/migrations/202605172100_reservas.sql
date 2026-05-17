-- ═══════════════════════════════════════════════════════════════════════════
-- Sistema de Reservas — esqueleto inicial
-- Sesión 2026-05-17
--
-- Permite que el dueño/encargado tome reservas de mesas vía teléfono o app
-- y las visualice en una agenda diaria por sucursal. Sin integración pública
-- con TheFork/Google Reservas (eso queda como Fase 2 cuando se decida).
--
-- Modelo:
--   - Una reserva pertenece a UN local. No se "reserva" una mesa específica
--     (se asigna al sentar al cliente) — solo se bloquea el slot horario
--     + cantidad de covers.
--   - Estados: pendiente (recién creada), confirmada (cliente confirmó),
--     sentada (llegó y está ocupando mesa), cancelada, no_show (no apareció).
--   - Datos del cliente: nombre + teléfono + opcional email.
--   - Auditoría: created_at + created_by para saber quién la tomó.
--   - Notas: campo libre para "alérgico al maní", "cumpleaños", etc.
--
-- Lista de espera: por ahora la modelamos como reservas con fecha = hoy y
-- hora = NULL (cuando se libera mesa, se confirma + se asigna hora).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reservas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id        INTEGER NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INTEGER NOT NULL REFERENCES usuarios(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Fecha del servicio. hora_inicio puede ser NULL para lista de espera
  -- (se asigna al confirmar).
  fecha           DATE NOT NULL,
  hora_inicio     TIME NULL,
  -- Duración esperada (default 1h30 — típico restaurant a la carta).
  duracion_min    INTEGER NOT NULL DEFAULT 90,

  -- Cliente
  cliente_nombre  TEXT NOT NULL CHECK (length(trim(cliente_nombre)) > 0),
  cliente_telefono TEXT NULL,
  cliente_email   TEXT NULL,
  covers          INTEGER NOT NULL CHECK (covers >= 1 AND covers <= 50),

  -- Estado
  estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK (
    estado IN ('pendiente', 'confirmada', 'sentada', 'cancelada', 'no_show')
  ),

  -- Asignación de mesa (opcional — solo cuando se sienta al cliente).
  -- Por ahora TEXT libre para no acoplar a COMANDA todavía. Cuando se
  -- integre, este campo se vuelve FK a comanda.mesas.
  mesa_asignada   TEXT NULL,

  -- Notas libres del staff (alergias, cumpleaños, preferencias).
  notas           TEXT NULL,

  -- Origen — para distinguir reservas tomadas por teléfono vs cargadas
  -- por una app pública en el futuro.
  origen          TEXT NOT NULL DEFAULT 'manual' CHECK (
    origen IN ('manual', 'whatsapp', 'web_publica', 'instagram', 'otro')
  ),

  -- Auditoría de cambios de estado importantes
  confirmada_at   TIMESTAMPTZ NULL,
  cancelada_at    TIMESTAMPTZ NULL,
  cancelada_motivo TEXT NULL,
  sentada_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_reservas_fecha_local ON reservas(fecha, local_id);
CREATE INDEX IF NOT EXISTS idx_reservas_tenant ON reservas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reservas_estado_pendientes ON reservas(local_id, fecha) WHERE estado IN ('pendiente', 'confirmada');

CREATE TRIGGER trg_reservas_set_updated_at BEFORE UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE reservas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservas_select ON reservas;
CREATE POLICY reservas_select ON reservas FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    ))
  );

DROP POLICY IF EXISTS reservas_modify ON reservas;
CREATE POLICY reservas_modify ON reservas FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    ))
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    ))
  );

DROP POLICY IF EXISTS reservas_service ON reservas;
CREATE POLICY reservas_service ON reservas FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE reservas IS
  'Reservas de mesas tomadas por staff (teléfono/WhatsApp) o cargadas desde app pública futura. Esqueleto inicial 2026-05-17. Sin integración con TheFork/Google Reservas todavía.';

NOTIFY pgrst, 'reload schema';
