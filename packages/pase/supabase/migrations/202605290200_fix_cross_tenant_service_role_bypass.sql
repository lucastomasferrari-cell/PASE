-- ═══════════════════════════════════════════════════════════════════════════
-- Fix E2E full suite — service_role bypass en _recompute_saldo_proveedor
--
-- La función _recompute_saldo_proveedor (introducida en F2 audit 27-may como
-- defense-in-depth contra cross-tenant) chequeaba:
--   auth_tenant_id() IS DISTINCT FROM v_tenant_id → RAISE PROVEEDOR_CROSS_TENANT
--
-- Pero cuando el caller usa service_role JWT:
--   - auth.uid() = NULL → auth_tenant_id() = NULL
--   - auth_es_superadmin() = FALSE (mira usuarios.auth_id = NULL → no match)
--   - NULL IS DISTINCT FROM <uuid> = TRUE → EXCEPTION
--
-- Esto rompió la suite E2E full (sprint-1/07, 09, 10) desde hace 5+ commits.
-- El seed E2E usa service_role para crear el tenant aislado + sus proveedores,
-- y al insertar facturas el trigger _recompute_saldo_proveedor explotaba.
--
-- Fix: bypass del check cuando el caller es service_role (que ya bypassa RLS
-- por diseño Supabase, así que el check de cross-tenant es redundante en ese
-- contexto). Mantiene el check estricto para callers `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _recompute_saldo_proveedor(p_proveedor_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_saldo NUMERIC;
  v_tenant_id UUID;
  v_caller_role TEXT;
BEGIN
  IF p_proveedor_id IS NULL THEN RETURN; END IF;

  -- AUDIT F2B #14: defense-in-depth cross-tenant.
  SELECT tenant_id INTO v_tenant_id FROM proveedores WHERE id = p_proveedor_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  -- 29-may fix: bypass cross-tenant check para service_role (server-side
  -- callers que ya bypassan RLS por diseño). El check sigue activo para
  -- callers `authenticated` que es donde realmente importa la defensa.
  BEGIN
    v_caller_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  EXCEPTION WHEN OTHERS THEN
    v_caller_role := NULL;
  END;

  IF v_caller_role IS DISTINCT FROM 'service_role'
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
