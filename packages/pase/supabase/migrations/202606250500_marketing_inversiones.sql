-- ═══════════════════════════════════════════════════════════════════════════
-- Marketing: registro de inversión publicitaria (pauta) — 25-jun-2026
--
-- Habitué (CRM/Marketing) registra acá la plata invertida en pauta (Meta Ads,
-- Google Ads, IG, etc.) para medir CAC (costo por cliente nuevo) y ROAS. La
-- carga es manual por ahora; la integración con las APIs de Meta/Google es un
-- paso aparte. Aditiva y segura.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketing_inversiones (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  local_id    INTEGER,                       -- NULL = a nivel marca/tenant
  fecha       DATE        NOT NULL,
  plataforma  TEXT        NOT NULL,          -- meta / google / instagram / otro
  campania    TEXT,
  monto       NUMERIC(14,2) NOT NULL DEFAULT 0,
  alcance     INTEGER,                       -- impresiones/alcance (opcional)
  clicks      INTEGER,                       -- clicks (opcional)
  notas       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

ALTER TABLE marketing_inversiones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inversiones_by_local" ON marketing_inversiones
  FOR ALL TO authenticated
  USING  (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL);

CREATE INDEX IF NOT EXISTS marketing_inversiones_fecha_idx
  ON marketing_inversiones (tenant_id, fecha DESC) WHERE deleted_at IS NULL;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name = 'marketing_inversiones') = 1,
         'marketing_inversiones no creada';
END;
$$;
