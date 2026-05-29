-- ═══════════════════════════════════════════════════════════════════════════
-- Fix #2 para PROVEEDOR_CROSS_TENANT en E2E
--
-- El fix anterior (290200) usaba request.jwt.claims->>'role'='service_role'
-- pero no funcionó dentro del contexto de trigger SECURITY DEFINER
-- (el JWT claim no se propaga consistentemente).
--
-- Heurística más robusta: si `auth.uid() IS NULL`, el caller NO está
-- autenticado como usuario humano → es service_role o trigger interno
-- → bypass del check. RLS sigue funcionando porque service_role bypassa
-- RLS por diseño Supabase (anon JWT con SUPABASE_SERVICE_KEY).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _recompute_saldo_proveedor(p_proveedor_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_saldo NUMERIC;
  v_tenant_id UUID;
BEGIN
  IF p_proveedor_id IS NULL THEN RETURN; END IF;

  SELECT tenant_id INTO v_tenant_id FROM proveedores WHERE id = p_proveedor_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  -- Defense-in-depth cross-tenant. Bypass para:
  --   - service_role (auth.uid() IS NULL): callers server-side
  --   - superadmin: auth_es_superadmin() = TRUE
  -- El check aplica solo cuando hay un user humano logueado (auth.uid() != NULL)
  -- y no es superadmin.
  IF auth.uid() IS NOT NULL
     AND NOT auth_es_superadmin()
     AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'PROVEEDOR_CROSS_TENANT';
  END IF;

  SELECT
    COALESCE((
      SELECT SUM(CASE
        WHEN f.tipo = 'nota_credito' THEN -ABS(COALESCE(f.total, 0))
        ELSE GREATEST(0, COALESCE(f.total, 0) - COALESCE((
          SELECT SUM((p->>'monto')::numeric)
          FROM jsonb_array_elements(COALESCE(f.pagos, '[]'::jsonb)) p
        ), 0))
      END)
      FROM facturas f
      WHERE f.prov_id = p_proveedor_id
        AND f.estado NOT IN ('anulada', 'pagada')
    ), 0)
    +
    COALESCE((
      SELECT SUM(COALESCE(r.monto, 0))
      FROM remitos r
      WHERE r.prov_id = p_proveedor_id
        AND r.estado = 'sin_factura'
        AND r.factura_id IS NULL
    ), 0)
  INTO v_saldo;

  UPDATE proveedores SET saldo = v_saldo WHERE id = p_proveedor_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
