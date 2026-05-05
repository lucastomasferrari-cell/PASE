-- ═══════════════════════════════════════════════════════════════════════════
-- MP justificativos — RPC tipo F (gasto existente).
--
-- La RPC `fn_conciliar_mp_con_existente('gasto',...)` introducida en
-- 202605080910 ya permite vincular a un gasto cargado previamente. Esta
-- RPC nueva añade lo único específico del flow F que la genérica no
-- entrega: la comparación de montos para devolver un warning legible
-- al frontend cuando el gasto y el egreso MP no cuadran exactamente.
--
-- El warning NO bloquea — Lucas confirmó que el monto puede diferir por
-- motivos legítimos (un gasto compuesto pagado en varios egresos, un
-- vuelto que se quedó en MP, redondeos). El frontend muestra el warning
-- y deja que el usuario decida.
--
-- justificativo_tipo se queda en 'gasto' (mismo valor que el flow C
-- "gasto nuevo") — el CHECK constraint no necesita cambios. Lo único
-- que distingue C de F es que C creó el gasto en el momento (con
-- movimiento contable y ajuste de saldos_caja) y F asume que el gasto
-- ya tenía su movimiento al cargarse, así que NO toca saldos_caja.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_conciliar_mp_con_gasto_existente(
  p_mp_mov_id  text,
  p_gasto_id   text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp            RECORD;
  v_usuario_id    integer;
  v_gasto_monto   numeric;
  v_mp_monto_abs  numeric;
  v_diff          numeric;
  v_warning       text := NULL;
BEGIN
  v_usuario_id := auth_usuario_id();
  IF v_usuario_id IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_USUARIO'; END IF;

  IF p_gasto_id IS NULL OR p_gasto_id = '' THEN
    RAISE EXCEPTION 'GASTO_ID_REQUERIDO';
  END IF;

  v_mp := _validar_mp_mov_conciliable(p_mp_mov_id);

  -- Existe + mismo tenant + no soft-deleted (gastos no tiene deleted_at;
  -- si en algún momento se agrega, ajustar acá).
  SELECT monto INTO v_gasto_monto
    FROM gastos
   WHERE id = p_gasto_id AND tenant_id = v_mp.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GASTO_NO_ENCONTRADO'; END IF;

  v_mp_monto_abs := abs(v_mp.monto);
  v_diff := v_gasto_monto - v_mp_monto_abs;

  -- Warning si la diferencia es > 1 peso. Tolerancia chica para evitar
  -- ruido de redondeos. La tabla 'gastos.monto' está en pesos (no en
  -- centavos) por convención del codebase — round a 2 decimales en el
  -- display final, no acá.
  IF abs(v_diff) > 1.00 THEN
    v_warning := 'Monto del gasto (' || v_gasto_monto::text || ') no coincide con egreso MP ('
                || v_mp_monto_abs::text || '). Diferencia: ' || v_diff::text;
  END IF;

  UPDATE mp_movimientos
     SET justificativo_tipo = 'gasto',
         justificativo_id   = p_gasto_id,
         justificativo_at   = now(),
         justificativo_por  = v_usuario_id
   WHERE id = p_mp_mov_id;

  PERFORM _auditar('mp_movimientos', 'CONCILIAR_GASTO_EXISTENTE', jsonb_build_object(
    'mp_mov_id', p_mp_mov_id, 'gasto_id', p_gasto_id,
    'mp_monto', v_mp_monto_abs, 'gasto_monto', v_gasto_monto,
    'diff', v_diff, 'usuario_id', v_usuario_id
  ), v_mp.tenant_id);

  RETURN jsonb_build_object(
    'mp_mov_id',   p_mp_mov_id,
    'tipo',        'gasto',
    'gasto_id',    p_gasto_id,
    'gasto_monto', v_gasto_monto,
    'mp_monto',    v_mp_monto_abs,
    'diff',        v_diff,
    'warning',     v_warning
  );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_conciliar_mp_con_gasto_existente(text, text) TO authenticated;
