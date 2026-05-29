-- ─────────────────────────────────────────────────────────────────────────
-- Tracking de costo de Anthropic API por cada request del proxy /api/claude.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Hasta hoy, solo trackeamos:
--   - ig_mensajes.llm_cost_usd (bot Instagram)
--   - tickets_soporte.agent_cost_usd (chat de soporte)
--
-- El Lector de Facturas IA (consume Opus 4.7 = caro) NO trackea nada.
-- Lucas cargó USD $8 en Anthropic. $1.31 fue del bot IG + $1.26 del chat
-- soporte. Los otros ~$5-6 fueron del lector IA y otros usos que no
-- quedaron registrados — por eso no entendíamos el desbalance.
--
-- Esta tabla captura CADA request al proxy con tenant + usuario + task +
-- modelo + tokens + costo calculado. Permite responder:
--   - ¿Cuánto gastamos este mes?
--   - ¿Qué task consume más?
--   - ¿Qué usuario usa más AI?
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.llm_usage_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id UUID,
  usuario_id INTEGER,
  task TEXT, -- 'soporte-chat', 'gastro-sensei', 'legacy' (lector IA y otros)
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'pase-api',
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_log_tenant_date
  ON public.llm_usage_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_log_date
  ON public.llm_usage_log(created_at DESC);

-- RLS — superadmin ve todo, dueño/admin ven los de su tenant
ALTER TABLE public.llm_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY llm_usage_log_select_policy ON public.llm_usage_log
  FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (auth_es_dueno_o_admin() AND tenant_id = auth_tenant_id())
  );

-- INSERT solo desde service_role (el endpoint /api/claude.js lo invoca con
-- SUPABASE_SERVICE_KEY). authenticated NO debería insertar directo.
-- (Service role bypasea RLS, no necesita policy explícita)

COMMENT ON TABLE public.llm_usage_log IS
  'Tracking de costo de Anthropic API por request. Cada llamada a /api/claude '
  'agrega una fila acá. Permite ver gasto por mes/tenant/task/usuario. '
  'Creada 29-may para entender desbalance entre $8 cargados y $1.31 registrados '
  'en ig_mensajes + $1.26 en tickets_soporte = ~$5 invisibles del lector IA.';

-- View útil para ver el gasto del mes
CREATE OR REPLACE VIEW public.v_llm_usage_mes AS
SELECT
  tenant_id,
  to_char(created_at, 'YYYY-MM') AS mes,
  task,
  model,
  count(*)::int AS requests,
  SUM(tokens_in)::int AS tokens_in_total,
  SUM(tokens_out)::int AS tokens_out_total,
  ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd_total
FROM public.llm_usage_log
GROUP BY tenant_id, to_char(created_at, 'YYYY-MM'), task, model
ORDER BY mes DESC, cost_usd_total DESC;

COMMENT ON VIEW public.v_llm_usage_mes IS
  'Resumen mensual de uso/costo de Anthropic API por tenant/task/model.';
