-- ═══════════════════════════════════════════════════════════════════════════
-- Fix definitivo del cap diario del bot IG para tenants MULTI-CUENTA.
-- 27-jun-2026
--
-- La versión anterior (202606261200 + 202606271300) tenía 2 bugs que hacían
-- que fn_reservar_cap_diario_ig SIEMPRE fallara → el webhook hacía `return` →
-- el bot NO contestaba ningún DM:
--   1. tenant_id (uuid) = p_tenant_id (text)  [arreglado en 271300]
--   2. UPDATE ... RETURNING ... INTO con N filas por tenant (Neko tiene 2
--      cuentas: nekosushi + maneki) → "query returned more than one row".
--
-- Acá: cap POR TENANT bien hecho. El gasto se agrega sobre TODAS las cuentas
-- del tenant; la reserva se escribe en una fila canónica (el id más chico) para
-- no doble-contar. Sin RETURNING-INTO multi-fila. Resetea por día.
-- Como el webhook ya desplegado llama estas RPCs, arreglarlas acá restaura las
-- respuestas SIN necesidad de redeployar.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION fn_reservar_cap_diario_ig(
  p_tenant_id TEXT,
  p_estimate_usd NUMERIC DEFAULT 0.10
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := p_tenant_id::uuid;
  v_cap NUMERIC;
  v_total NUMERIC;
  v_target_id BIGINT;
BEGIN
  -- Reset de los contadores del día viejo (todas las cuentas del tenant).
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = 0, gasto_hoy_fecha = CURRENT_DATE
   WHERE tenant_id = v_tenant
     AND (gasto_hoy_fecha IS NULL OR gasto_hoy_fecha <> CURRENT_DATE);

  -- Cap del tenant (el más restrictivo entre sus cuentas, fallback $5) y gasto
  -- total de hoy agregando todas las cuentas.
  SELECT COALESCE(MIN(cap_diario_usd), 5), COALESCE(SUM(gasto_hoy_acumulado_usd), 0)
    INTO v_cap, v_total
    FROM ig_config WHERE tenant_id = v_tenant;

  -- Si no hay config para el tenant, no bloqueamos (ok, sin cap real).
  IF v_cap IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'cap', NULL, 'reservado', 0, 'estimate', p_estimate_usd);
  END IF;

  IF v_total + p_estimate_usd > v_cap THEN
    RETURN jsonb_build_object('ok', false, 'cap', v_cap, 'gastado', v_total, 'estimate', p_estimate_usd);
  END IF;

  -- Reservar el estimate en una sola fila canónica (id más chico).
  SELECT id INTO v_target_id FROM ig_config WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = gasto_hoy_acumulado_usd + p_estimate_usd,
         gasto_hoy_fecha = CURRENT_DATE
   WHERE id = v_target_id;

  RETURN jsonb_build_object('ok', true, 'cap', v_cap, 'reservado', v_total + p_estimate_usd, 'estimate', p_estimate_usd);
END;
$$;

CREATE OR REPLACE FUNCTION fn_ajustar_cap_diario_ig(
  p_tenant_id TEXT,
  p_costo_real_usd NUMERIC,
  p_estimate_reservado_usd NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := p_tenant_id::uuid;
  v_target_id BIGINT;
BEGIN
  SELECT id INTO v_target_id FROM ig_config WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  IF v_target_id IS NULL THEN RETURN; END IF;
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = GREATEST(0,
       gasto_hoy_acumulado_usd + (p_costo_real_usd - p_estimate_reservado_usd))
   WHERE id = v_target_id
     AND gasto_hoy_fecha = CURRENT_DATE;
END;
$$;

REVOKE ALL ON FUNCTION fn_reservar_cap_diario_ig(TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_reservar_cap_diario_ig(TEXT, NUMERIC) TO service_role;
REVOKE ALL ON FUNCTION fn_ajustar_cap_diario_ig(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_ajustar_cap_diario_ig(TEXT, NUMERIC, NUMERIC) TO service_role;

COMMIT;
