-- ═══════════════════════════════════════════════════════════════════════════
-- Parte operativo de turno (cierre extendido) — 24-jun-2026
--
-- Al cerrar caja, el encargado puede (opcionalmente) dejar un parte
-- operativo del turno: faltas, llegadas tarde, reclamos de clientes y
-- un comentario libre.
--
-- Si el dueño habilita "parte_obligatorio" en comanda_local_settings
-- (campo futuro), el frontend bloquea el cierre hasta completarlo.
-- Por ahora el campo no existe — el parte es siempre opcional.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS partes_operativos (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  local_id     INTEGER     NOT NULL,
  turno_id     INTEGER     REFERENCES turnos_caja(id) ON DELETE SET NULL,
  -- Ids de empleados (TEXT = UUID de rrhh_empleados)
  empleados_falta  TEXT[]  NOT NULL DEFAULT '{}',
  empleados_tarde  TEXT[]  NOT NULL DEFAULT '{}',
  reclamos         TEXT,
  comentario       TEXT,
  cerrado_por      TEXT    REFERENCES rrhh_empleados(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE partes_operativos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "partes_by_local" ON partes_operativos
  FOR ALL TO authenticated
  USING  (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()));

-- Índice para listados cronológicos por local
CREATE INDEX IF NOT EXISTS partes_operativos_local_at_idx
  ON partes_operativos (local_id, created_at DESC);

-- Verificación
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name = 'partes_operativos') = 1,
         'partes_operativos not created';
END;
$$;
