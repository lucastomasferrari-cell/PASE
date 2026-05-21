-- ═══════════════════════════════════════════════════════════════════════════
-- ALTO-6 Auditoría 2026-05-21: N+1 en Tenants.tsx (admin-console)
--
-- Antes: por cada tenant del listado, 2 queries count (locales + usuarios)
-- en Promise.all. 10 tenants = 20 queries en serie de batches.
--
-- Fix: una sola RPC con LEFT JOIN + GROUP BY que devuelve toda la tabla
-- con counts. Solo superadmin puede llamarla.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_tenants_con_counts()
RETURNS TABLE (
  id UUID,
  nombre TEXT,
  slug TEXT,
  activo BOOLEAN,
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  num_locales BIGINT,
  num_usuarios BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SOLO_SUPERADMIN';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.nombre,
    t.slug,
    t.activo,
    t.trial_ends_at,
    t.created_at,
    COALESCE(l.cnt, 0) AS num_locales,
    COALESCE(u.cnt, 0) AS num_usuarios
  FROM tenants t
  LEFT JOIN (
    SELECT tenant_id, COUNT(*) AS cnt
      FROM locales
     GROUP BY tenant_id
  ) l ON l.tenant_id = t.id
  LEFT JOIN (
    SELECT tenant_id, COUNT(*) AS cnt
      FROM usuarios
     WHERE tenant_id IS NOT NULL
     GROUP BY tenant_id
  ) u ON u.tenant_id = t.id
  ORDER BY t.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_tenants_con_counts() TO authenticated;

NOTIFY pgrst, 'reload schema';
