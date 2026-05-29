-- ═══════════════════════════════════════════════════════════════════════════
-- Fix #4 PROVEEDOR_CROSS_TENANT — fn_recalcular_saldo_proveedor
--
-- Hay 2 funciones con el check cross-tenant:
--   - _recompute_saldo_proveedor (helper interno) ← ya fixeé en 290400
--   - fn_recalcular_saldo_proveedor (la que SÍ llama el trigger trg_saldo_prov_facturas
--     → trg_saldo_proveedor()) ← FALTABA fix
--
-- Mismo approach: bypass cuando auth_tenant_id() IS NULL.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_recalcular_saldo_proveedor(p_proveedor_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_saldo NUMERIC;
  v_tenant_id UUID;
  v_caller_tenant UUID;
BEGIN
  IF p_proveedor_id IS NULL THEN RETURN; END IF;

  SELECT tenant_id INTO v_tenant_id FROM proveedores WHERE id = p_proveedor_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'PROVEEDOR_NO_ENCONTRADO'; END IF;

  -- 29-may fix #4: bypass cuando no hay tenant context (service_role, jobs).
  v_caller_tenant := auth_tenant_id();
  IF v_caller_tenant IS NOT NULL
     AND NOT auth_es_superadmin()
     AND v_tenant_id IS DISTINCT FROM v_caller_tenant THEN
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
