-- ═══════════════════════════════════════════════════════════════════════════
-- Fix #3 (definitivo) para PROVEEDOR_CROSS_TENANT en E2E
--
-- Los fix anteriores no funcionaron:
--   - 290200 usaba jwt.claims->>'role'='service_role' → no propaga dentro de
--     trigger SECURITY DEFINER.
--   - 290300 usaba auth.uid() IS NULL → tampoco.
--
-- Estrategia final: bypass si auth_tenant_id() IS NULL. Cuando no hay tenant
-- context (caller es service_role, trigger interno, o job sin auth), no hay
-- razón para chequear cross-tenant — el caller ya bypassa RLS o es interno.
-- RLS sigue protegiendo en la capa de policies (caller authenticated debe
-- tener tenant_id correcto para insertar facturas/remitos).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION _recompute_saldo_proveedor(p_proveedor_id INTEGER)
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

  -- 29-may fix #3: bypass si NO hay tenant context (service_role, jobs, etc.)
  -- RLS sigue protegiendo en la capa de policies para callers authenticated.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Bug #2: GRANT EXECUTE en _resync_pago_especial
-- Error en E2E: "pagar_aguinaldo: permission denied for function
-- _resync_pago_especial". La función existe pero no fue grant-eada a
-- authenticated (es helper interno llamado por pagar_aguinaldo, pero la
-- llamada se hace en SECURITY INVOKER y necesita grant).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = '_resync_pago_especial'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION _resync_pago_especial(UUID) TO authenticated';
  END IF;
END$$;

NOTIFY pgrst, 'reload schema';
