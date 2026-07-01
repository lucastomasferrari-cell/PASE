-- ============================================================
-- Motor de reservas por MESA REAL (estilo OpenTable) — parte 1: esquema.
--
-- Hasta ahora la disponibilidad era por CUBIERTOS globales (un tope plano).
-- Pasamos a reservar contra el INVENTARIO REAL de mesas: cada mesa con su
-- capacidad, turn-time por grupo, pacing por franja y combinación de 2 mesas.
--
-- Columnas nuevas:
--   mesas.reservable            → el local puede excluir mesas del online (barra, staff).
--   reservas.mesas_ids          → mesas asignadas (soporta combo de 2); mesa_id = primaria.
--   comanda_local_settings:
--     reservas_motor            → 'auto' (mesas si hay reservables, sino cupo) | 'mesas' | 'cupo'
--     reservas_permite_combinar → combinar 2 mesas si no entra en una
--     reservas_pacing_max_por_franja → máx reservas que ARRANCAN en una franja (NULL = sin pacing)
--     reservas_franja_min       → tamaño de la franja de pacing (default 15 min)
-- ============================================================

ALTER TABLE mesas
  ADD COLUMN IF NOT EXISTS reservable BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS mesas_ids BIGINT[];

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS reservas_motor TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS reservas_permite_combinar BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reservas_pacing_max_por_franja INTEGER,
  ADD COLUMN IF NOT EXISTS reservas_franja_min INTEGER NOT NULL DEFAULT 15;

-- Índice para chequear rápido las reservas que ocupan una mesa en una ventana.
CREATE INDEX IF NOT EXISTS idx_reservas_mesa_ventana
  ON reservas (local_id, fecha_hora)
  WHERE estado IN ('pendiente','confirmada','sentada') AND deleted_at IS NULL;
