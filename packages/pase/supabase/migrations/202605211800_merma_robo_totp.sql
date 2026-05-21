-- ═══════════════════════════════════════════════════════════════════════════
-- Manager Override TOTP integrado en registro de mermas (robo en particular)
--
-- Hasta ahora fn_registrar_merma recibía un p_manager_id que el caller
-- debía obtener "por afuera" — eso era inseguro porque un cliente
-- malicioso podía pasar cualquier integer.
--
-- Ahora la RPC recibe p_override_code (6 dígitos TOTP). Si el motivo
-- es de tipo 'robo':
--   - Si el caller tiene permiso 'stock_anular' o es dueño/admin → OK
--     sin código (porque ellos pueden cargar robo directamente).
--   - Si no → exige código TOTP válido + no usado, vía la función
--     auth_tiene_permiso_o_override (que valida + consume en
--     manager_override_usos para garantizar 1-use real).
--
-- Patrón consistente con anular_factura, anular_movimiento, etc.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop la firma vieja (migration anterior 202605211700) porque cambiamos
-- la lista de parámetros agregando p_override_code. CREATE OR REPLACE no
-- reemplaza si la firma cambió — crea una nueva, lo que deja ambas
-- coexistiendo y rompe el supabase-js (no sabe cuál usar).
DROP FUNCTION IF EXISTS fn_registrar_merma(BIGINT, INTEGER, NUMERIC, BIGINT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION fn_registrar_merma(
  p_insumo_id BIGINT,
  p_local_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo_id BIGINT,
  p_notas TEXT DEFAULT NULL,
  p_manager_id INTEGER DEFAULT NULL,  -- legacy, no se usa ya — TODO drop
  p_override_code TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_motivo RECORD;
  v_insumo RECORD;
  v_mov_id BIGINT;
  v_user_id INTEGER;
  v_manager_id INTEGER := NULL;
  v_override_ok BOOLEAN;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- Lookup del id INTEGER del usuario logueado
  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  -- Validar permisos sobre el local
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Validar cantidad
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;

  -- Cargar motivo y validar
  SELECT * INTO v_motivo FROM mermas_motivos
    WHERE id = p_motivo_id
      AND tenant_id = v_tenant_id
      AND activo = TRUE
      AND deleted_at IS NULL;
  IF v_motivo IS NULL THEN RAISE EXCEPTION 'MOTIVO_NO_ENCONTRADO'; END IF;

  -- Si es robo: exigir override TOTP o permiso especial
  IF v_motivo.tipo_movimiento = 'robo' THEN
    -- auth_tiene_permiso_o_override valida + consume el código vía
    -- manager_override_usos. Devuelve TRUE si el caller ya tiene el
    -- permiso (dueño/admin/usuario con stock_anular) o si presentó
    -- un código TOTP válido no usado.
    v_override_ok := auth_tiene_permiso_o_override(
      'stock_anular',
      p_override_code,
      'registrar_robo_insumo',
      jsonb_build_object(
        'insumo_id', p_insumo_id,
        'local_id', p_local_id,
        'cantidad', p_cantidad,
        'motivo', v_motivo.nombre
      )
    );
    IF NOT v_override_ok THEN
      IF p_override_code IS NULL THEN
        RAISE EXCEPTION 'ROBO_REQUIERE_OVERRIDE';
      ELSE
        RAISE EXCEPTION 'OVERRIDE_INVALIDO';
      END IF;
    END IF;
    -- Si llegamos acá, el caller tiene el permiso o el código fue válido.
    -- El manager_id queda NULL — no sabemos quién dictó el código pero
    -- queda registrado en manager_override_usos.
    v_manager_id := NULL;
  END IF;

  -- Cargar insumo (para costo y unidad)
  SELECT * INTO v_insumo FROM insumos
    WHERE id = p_insumo_id
      AND tenant_id = v_tenant_id
      AND deleted_at IS NULL;
  IF v_insumo IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  -- Insertar movimiento (cantidad NEGATIVA por convención de salida)
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id, manager_id
  ) VALUES (
    v_tenant_id, p_local_id, p_insumo_id, v_motivo.tipo_movimiento,
    -p_cantidad, COALESCE(v_insumo.costo_actual, 0),
    v_motivo.nombre || COALESCE(' — ' || p_notas, ''),
    'merma_motivo', p_motivo_id,
    v_user_id, v_manager_id
  ) RETURNING id INTO v_mov_id;

  RETURN v_mov_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_registrar_merma(BIGINT, INTEGER, NUMERIC, BIGINT, TEXT, INTEGER, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
