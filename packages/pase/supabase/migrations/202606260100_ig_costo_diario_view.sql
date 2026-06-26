-- ═══════════════════════════════════════════════════════════════════════════
-- v_ig_costo_diario_tenant — costo del bot IG hoy por tenant
-- 26-jun-2026
--
-- Vista para admin-console: en Tenants.tsx Lucas ve de un vistazo qué tenant
-- está gastando más en el bot hoy y si alguno se está acercando a su cap.
-- Lee ig_mensajes.llm_cost_usd (loggeado por mensaje) + ig_config.cap_diario_usd
-- (cap por tenant, default $5 desde migración 202606260000).
--
-- Aditiva y segura. Vista, no tabla — no rompe nada.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_ig_costo_diario_tenant AS
SELECT
  c.tenant_id,
  COALESCE(MAX(c.cap_diario_usd), 5.00) AS cap_diario_usd,
  COALESCE(SUM(
    CASE WHEN m.created_at >= CURRENT_DATE THEN m.llm_cost_usd ELSE 0 END
  ), 0)::NUMERIC(10,4) AS gasto_hoy_usd,
  COALESCE(SUM(
    CASE WHEN m.created_at >= CURRENT_DATE - INTERVAL '7 days' THEN m.llm_cost_usd ELSE 0 END
  ), 0)::NUMERIC(10,4) AS gasto_7d_usd,
  COUNT(*) FILTER (
    WHERE m.created_at >= CURRENT_DATE AND m.direccion = 'out' AND m.origen = 'bot'
  ) AS mensajes_hoy
FROM ig_config c
LEFT JOIN ig_mensajes m ON m.tenant_id = c.tenant_id
GROUP BY c.tenant_id;

COMMENT ON VIEW v_ig_costo_diario_tenant IS
  'Costo del bot IG por tenant: hoy, últimos 7d, mensajes hoy. Usado por admin-console para alertar de cost-runaway.';

-- Solo superadmin lee la vista (incluye datos cross-tenant).
-- En admin-console se accede vía service_role; el bloque de RLS no aplica a
-- vistas pero conviene revocar PUBLIC por las dudas.
REVOKE ALL ON v_ig_costo_diario_tenant FROM PUBLIC;
GRANT SELECT ON v_ig_costo_diario_tenant TO authenticated;
