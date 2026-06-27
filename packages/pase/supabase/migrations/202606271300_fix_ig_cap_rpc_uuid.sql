-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: las RPCs del cap diario del bot IG comparaban ig_config.tenant_id (uuid)
-- contra el parámetro p_tenant_id (text) → "operator does not exist: uuid = text"
-- en runtime. La RPC nunca funcionó; cuando el webhook que la llama se activó en
-- prod (27-jun), CORTABA la respuesta del bot a TODOS los DMs (el webhook hace
-- `return` si fn_reservar_cap_diario_ig devuelve error).
--
-- Fix mínimo: castear el parámetro a uuid en el WHERE (misma firma → no rompe
-- los GRANT a service_role). CREATE OR REPLACE.
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
  v_cap NUMERIC;
  v_acumulado_nuevo NUMERIC;
BEGIN
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = CASE
           WHEN gasto_hoy_fecha = CURRENT_DATE
             THEN gasto_hoy_acumulado_usd + p_estimate_usd
           ELSE p_estimate_usd
         END,
         gasto_hoy_fecha = CURRENT_DATE
   WHERE tenant_id = p_tenant_id::uuid
     AND (
       gasto_hoy_fecha IS NULL
       OR gasto_hoy_fecha <> CURRENT_DATE
       OR gasto_hoy_acumulado_usd + p_estimate_usd <= COALESCE(cap_diario_usd, 5)
     )
  RETURNING cap_diario_usd, gasto_hoy_acumulado_usd
  INTO v_cap, v_acumulado_nuevo;

  IF v_acumulado_nuevo IS NULL THEN
    SELECT cap_diario_usd, gasto_hoy_acumulado_usd
      INTO v_cap, v_acumulado_nuevo
      FROM ig_config WHERE tenant_id = p_tenant_id::uuid;
    RETURN jsonb_build_object(
      'ok', false,
      'cap', COALESCE(v_cap, 5),
      'gastado', COALESCE(v_acumulado_nuevo, 0),
      'estimate', p_estimate_usd
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cap', v_cap,
    'reservado', v_acumulado_nuevo,
    'estimate', p_estimate_usd
  );
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
BEGIN
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = GREATEST(0,
       gasto_hoy_acumulado_usd + (p_costo_real_usd - p_estimate_reservado_usd))
   WHERE tenant_id = p_tenant_id::uuid
     AND gasto_hoy_fecha = CURRENT_DATE;
END;
$$;

REVOKE ALL ON FUNCTION fn_reservar_cap_diario_ig(TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_reservar_cap_diario_ig(TEXT, NUMERIC) TO service_role;
REVOKE ALL ON FUNCTION fn_ajustar_cap_diario_ig(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_ajustar_cap_diario_ig(TEXT, NUMERIC, NUMERIC) TO service_role;

COMMIT;
