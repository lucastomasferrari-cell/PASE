-- ═══════════════════════════════════════════════════════════════════════════
-- fn_cuadre_caja con lock pesimista
-- 26-jun-2026
--
-- Fix audit 26-jun ALTO-3: la versión original (migración 202606260300)
-- leía SUM(monto) FROM movimientos_caja sin lock. Si un cajero hacía el
-- cuadre mientras otro cargaba un movimiento al mismo turno, el cálculo de
-- `sistema_efectivo` quedaba stale y la `diferencia` se grababa mal.
--
-- Fix: usar `pg_advisory_xact_lock(p_turno_id)` al inicio de la función.
-- Cualquier cuadre que entre durante el cuadre activo del mismo turno se
-- bloquea hasta que el primero termine (transacción muy corta, ~5-10ms).
-- Los movimientos cargados en el medio se ven al releer el SUM.
--
-- Aditivo: solo reescribe la función. La signature, los errores y el
-- contrato siguen siendo idénticos a la versión 202606260300.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

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

  -- ── Lock pesimista sobre el turno ───────────────────────────────────────
  -- Serializa cualquier otra ejecución de fn_cuadre_caja sobre el mismo
  -- turno hasta el final de esta transacción. Cualquier movimientos_caja
  -- que se INSERTA fuera de este lock se ve en el SELECT de abajo (PG MVCC).
  -- Fix audit ALTO-3.
  PERFORM pg_advisory_xact_lock(hashtext('cuadre_caja_'::text || p_turno_id::text));

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

  -- Calcular efectivo del sistema: suma de movimientos efectivo del turno.
  -- El lock advisory garantiza que los INSERTs concurrentes no estén en
  -- vuelo durante este SELECT — están serializados antes o después.
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

COMMIT;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.routines WHERE routine_name = 'fn_cuadre_caja') = 1,
         'fn_cuadre_caja no creada';
  RAISE NOTICE '✓ fn_cuadre_caja con advisory lock';
END $$;
