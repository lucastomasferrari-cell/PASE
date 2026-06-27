-- ═══════════════════════════════════════════════════════════════════════════
-- Cap diario USD del bot IG — counter atómico (fix race condition)
-- 26-jun-2026
--
-- Fix audit 26-jun ALTO-2: el webhook IG calculaba el gasto del día con
-- SUM(llm_cost_usd) y comparaba con cap_diario_usd. Si dos mensajes llegaban
-- en la misma ventana de ms, ambos pasaban el check (ambos leían el mismo SUM
-- viejo, antes de que ninguno hubiera insertado su mensaje). Resultado:
-- cap excedido ~$1-2 USD/día en el peor caso.
--
-- Solución: contador atómico `gasto_hoy_acumulado_usd` en ig_config + RPC
-- `fn_reservar_cap_diario_ig` que hace UPDATE atómico con estimate, y
-- `fn_ajustar_cap_diario_ig` que corrige con el cost real una vez que Claude
-- responde.
--
-- Flujo:
--   1. webhook → fn_reservar_cap_diario_ig(tenant, $0.10 estimate)
--   2. si !ok → skip (cap superado)
--   3. si ok → llamar Claude
--   4. ya con cost real → fn_ajustar_cap_diario_ig(tenant, cost_real, $0.10)
--
-- El "estimate" es conservador ($0.10/msg). Si el real es menor, se ajusta
-- a la baja. Si es mayor, se ajusta a la alza. La race está cerrada porque
-- el UPDATE atómico ya reservó el estimate antes de llamar a Claude.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS gasto_hoy_acumulado_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gasto_hoy_fecha DATE;

COMMENT ON COLUMN ig_config.gasto_hoy_acumulado_usd IS
  'Contador atómico del gasto USD del bot HOY. Se reserva con estimate antes de llamar Claude, se ajusta con cost real después. Resetea cuando gasto_hoy_fecha != CURRENT_DATE.';

-- ─── RPC: reservar un slot de costo dentro del cap diario ───────────────────
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
  -- UPDATE atómico: pasa solo si (es un día nuevo) O (acumulado + estimate <= cap).
  -- Si pasa, suma el estimate al acumulado y devuelve el nuevo valor.
  -- Si no pasa, returning trae NULL.
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = CASE
           WHEN gasto_hoy_fecha = CURRENT_DATE
             THEN gasto_hoy_acumulado_usd + p_estimate_usd
           ELSE p_estimate_usd
         END,
         gasto_hoy_fecha = CURRENT_DATE
   WHERE tenant_id = p_tenant_id
     AND (
       gasto_hoy_fecha IS NULL
       OR gasto_hoy_fecha <> CURRENT_DATE
       OR gasto_hoy_acumulado_usd + p_estimate_usd <= COALESCE(cap_diario_usd, 5)
     )
  RETURNING cap_diario_usd, gasto_hoy_acumulado_usd
  INTO v_cap, v_acumulado_nuevo;

  IF v_acumulado_nuevo IS NULL THEN
    -- No pasó el check. Levantar estado actual para diagnóstico.
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

-- ─── RPC: ajustar acumulado con el cost real una vez Claude respondió ───────
CREATE OR REPLACE FUNCTION fn_ajustar_cap_diario_ig(
  p_tenant_id TEXT,
  p_costo_real_usd NUMERIC,
  p_estimate_reservado_usd NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ajustar: sumar (real - estimate) al acumulado. Si real < estimate libera,
  -- si real > estimate reserva un poco más. Solo dentro del mismo día.
  UPDATE ig_config
     SET gasto_hoy_acumulado_usd = GREATEST(0,
       gasto_hoy_acumulado_usd + (p_costo_real_usd - p_estimate_reservado_usd))
   WHERE tenant_id = p_tenant_id
     AND gasto_hoy_fecha = CURRENT_DATE;
END;
$$;

-- Permisos: solo service_role (el webhook usa SUPABASE_SERVICE_KEY).
REVOKE ALL ON FUNCTION fn_reservar_cap_diario_ig(TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_reservar_cap_diario_ig(TEXT, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION fn_ajustar_cap_diario_ig(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_ajustar_cap_diario_ig(TEXT, NUMERIC, NUMERIC) TO service_role;

COMMIT;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.routines WHERE routine_name = 'fn_reservar_cap_diario_ig') = 1,
         'fn_reservar_cap_diario_ig no creada';
  ASSERT (SELECT COUNT(*) FROM information_schema.routines WHERE routine_name = 'fn_ajustar_cap_diario_ig') = 1,
         'fn_ajustar_cap_diario_ig no creada';
  RAISE NOTICE '✓ Cap atómico bot IG listo';
END $$;
