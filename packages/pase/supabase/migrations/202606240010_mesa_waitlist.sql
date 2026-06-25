-- MESA Módulo #5: Lista de espera (waitlist) para walk-ins.
-- Clientes que llegan sin reserva cuando el local está lleno.
-- El staff los anota, y cuando se libera una mesa los "llama"
-- (opcionalmente por WA) y luego los sienta.

CREATE TABLE IF NOT EXISTS waitlist (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  TEXT    NOT NULL,
  local_id   INTEGER NOT NULL,
  cliente_nombre    TEXT    NOT NULL,
  cliente_telefono  TEXT,
  personas          INTEGER NOT NULL DEFAULT 1 CHECK (personas > 0),
  notas             TEXT,
  estado            TEXT    NOT NULL DEFAULT 'esperando'
                    CHECK (estado IN ('esperando', 'llamado', 'sentado', 'cancelado')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  llamado_at        TIMESTAMPTZ,
  sentado_at        TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ
);

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- Encargados ven solo su local; dueño/admin ven todos.
CREATE POLICY "waitlist_by_local" ON waitlist
  FOR ALL TO authenticated
  USING  (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- Índice principal: por local + estado activo + hora de llegada
CREATE INDEX waitlist_local_activos_idx
  ON waitlist (local_id, created_at)
  WHERE estado IN ('esperando', 'llamado') AND deleted_at IS NULL;
