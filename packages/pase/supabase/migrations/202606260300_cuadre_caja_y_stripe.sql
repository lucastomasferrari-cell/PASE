-- ═══════════════════════════════════════════════════════════════════════════
-- 26-jun-2026: 3 mejoras grandes para piloto / 3ros
-- 1. Conciliación de caja: declaración del efectivo físico vs sistema → diferencia
-- 2. tenant_subscriptions enriquecida para Stripe (campos extra ya estaban)
-- 3. RPC fn_cuadre_caja atómica para registrar el cuadre del turno
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Conciliación de caja en parte_operativo ─────────────────────────────
ALTER TABLE partes_operativos
  ADD COLUMN IF NOT EXISTS declarado_efectivo NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS sistema_efectivo NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS diferencia NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS diferencia_justificacion TEXT,
  ADD COLUMN IF NOT EXISTS diferencia_aceptada_por TEXT;

COMMENT ON COLUMN partes_operativos.declarado_efectivo IS
  'Efectivo físico contado al cierre del turno (lo que hay en la caja).';
COMMENT ON COLUMN partes_operativos.sistema_efectivo IS
  'Suma de movimientos_caja efectivo del turno según el sistema.';
COMMENT ON COLUMN partes_operativos.diferencia IS
  'declarado - sistema. Positivo = sobró (probable error de tipeo). Negativo = faltó.';

-- ─── 2. RPC fn_cuadre_caja ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cuadre_caja(
  p_turno_id INTEGER,
  p_declarado_efectivo NUMERIC,
  p_justificacion TEXT DEFAULT NULL,
  p_aceptado_por TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
  v_tenant_id TEXT;
  v_sistema NUMERIC := 0;
  v_diferencia NUMERIC;
  v_parte_id BIGINT;
BEGIN
  -- Auth check (defense-in-depth, las RLS también aplican)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  -- Levantar el turno + local
  SELECT t.local_id, l.tenant_id::TEXT INTO v_local_id, v_tenant_id
  FROM turnos_caja t
  JOIN locales l ON l.id = t.local_id
  WHERE t.id = p_turno_id;

  IF v_local_id IS NULL THEN
    RAISE EXCEPTION 'TURNO_NO_ENCONTRADO';
  END IF;

  -- Validar que el caller tiene acceso al local
  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'NO_ACCESO_AL_LOCAL';
  END IF;

  -- Calcular efectivo del sistema: suma de movimientos efectivo del turno
  SELECT COALESCE(SUM(monto), 0) INTO v_sistema
  FROM movimientos_caja
  WHERE turno_id = p_turno_id
    AND metodo_cobro = 'efectivo';

  v_diferencia := p_declarado_efectivo - v_sistema;

  -- Upsert parte operativo (puede ya existir si el cajero cargó otras secciones)
  SELECT id INTO v_parte_id FROM partes_operativos WHERE turno_id = p_turno_id;

  IF v_parte_id IS NOT NULL THEN
    UPDATE partes_operativos SET
      declarado_efectivo = p_declarado_efectivo,
      sistema_efectivo = v_sistema,
      diferencia = v_diferencia,
      diferencia_justificacion = p_justificacion,
      diferencia_aceptada_por = p_aceptado_por
    WHERE id = v_parte_id;
  ELSE
    INSERT INTO partes_operativos (
      tenant_id, local_id, turno_id,
      declarado_efectivo, sistema_efectivo, diferencia,
      diferencia_justificacion, diferencia_aceptada_por
    ) VALUES (
      v_tenant_id, v_local_id, p_turno_id,
      p_declarado_efectivo, v_sistema, v_diferencia,
      p_justificacion, p_aceptado_por
    ) RETURNING id INTO v_parte_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'parte_id', v_parte_id,
    'sistema', v_sistema,
    'declarado', p_declarado_efectivo,
    'diferencia', v_diferencia,
    'estado', CASE
      WHEN ABS(v_diferencia) < 1 THEN 'cuadra'
      WHEN v_diferencia > 0 THEN 'sobra'
      ELSE 'falta'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cuadre_caja(INTEGER, NUMERIC, TEXT, TEXT) TO authenticated;

-- ─── 3. tenant_subscriptions: campos extra para Stripe ──────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_subscriptions') THEN
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT';
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT';
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id TEXT';
    EXECUTE 'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT';
  END IF;
END $$;

-- ─── 4. Vista de cuadre por turno (admin-console) ───────────────────────────
CREATE OR REPLACE VIEW v_cuadres_caja AS
SELECT
  p.id AS parte_id,
  p.tenant_id,
  p.local_id,
  p.turno_id,
  p.declarado_efectivo,
  p.sistema_efectivo,
  p.diferencia,
  p.diferencia_justificacion,
  p.diferencia_aceptada_por,
  CASE
    WHEN p.declarado_efectivo IS NULL THEN 'no_cuadrado'
    WHEN ABS(COALESCE(p.diferencia, 0)) < 1 THEN 'cuadra'
    WHEN p.diferencia > 0 THEN 'sobra'
    ELSE 'falta'
  END AS estado_cuadre,
  p.created_at
FROM partes_operativos p
WHERE p.turno_id IS NOT NULL;

COMMIT;

-- Verificación
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'partes_operativos' AND column_name = 'declarado_efectivo') = 1,
         'declarado_efectivo no agregada';
  ASSERT (SELECT COUNT(*) FROM information_schema.routines WHERE routine_name = 'fn_cuadre_caja') = 1,
         'fn_cuadre_caja no creada';
  RAISE NOTICE '✓ Conciliación caja + Stripe enrichment listos';
END $$;
