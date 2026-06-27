-- ═══════════════════════════════════════════════════════════════════════════
-- Fix timezone en cap diario USD del bot IG
-- 27-jun-2026
--
-- Bug detectado por code-review: las RPCs fn_reservar_cap_diario_ig y
-- fn_ajustar_cap_diario_ig usaban CURRENT_DATE (que es UTC en Supabase),
-- así que el contador se reseteaba a las 21:00 ART (medianoche UTC), no
-- a la medianoche real de Argentina.
--
-- Consecuencia: entre las 21:00 y 00:00 ART, el bot operaba con presupuesto
-- "del día siguiente" sin haberse terminado el día actual → cap efectivo
-- duplicado durante 3hs cada día.
--
-- Fix: usar (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
-- en todos los lugares donde antes había CURRENT_DATE.
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
  v_hoy_ar DATE := (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
BEGIN
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = CASE
           WHEN gasto_hoy_fecha = v_hoy_ar
             THEN gasto_hoy_acumulado_usd + p_estimate_usd
           ELSE p_estimate_usd
         END,
         gasto_hoy_fecha = v_hoy_ar
   WHERE tenant_id = p_tenant_id
     AND (
       gasto_hoy_fecha IS NULL
       OR gasto_hoy_fecha <> v_hoy_ar
       OR gasto_hoy_acumulado_usd + p_estimate_usd <= COALESCE(cap_diario_usd, 5)
     )
  RETURNING cap_diario_usd, gasto_hoy_acumulado_usd
  INTO v_cap, v_acumulado_nuevo;

  IF v_acumulado_nuevo IS NULL THEN
    SELECT cap_diario_usd, gasto_hoy_acumulado_usd
      INTO v_cap, v_acumulado_nuevo
      FROM ig_config WHERE tenant_id = p_tenant_id;
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
DECLARE
  v_hoy_ar DATE := (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
BEGIN
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = GREATEST(0,
       gasto_hoy_acumulado_usd + (p_costo_real_usd - p_estimate_reservado_usd))
   WHERE tenant_id = p_tenant_id
     AND gasto_hoy_fecha = v_hoy_ar;
END;
$$;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✓ fn_reservar_cap_diario_ig + fn_ajustar usan TZ Argentina';
END $$;
