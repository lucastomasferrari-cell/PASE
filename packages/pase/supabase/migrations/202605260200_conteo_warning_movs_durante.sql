-- ─────────────────────────────────────────────────────────────────────────
-- Conteo físico: detección de movs durante el conteo (preventivo)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Cierra parcialmente el ticket "Lock del cálculo teórico durante conteo
-- físico" anotado el 24-may. El fix REAL (bloquear movs durante conteo)
-- es muy invasivo — bloquearía POS mientras el dueño cuenta inventario.
-- En cambio, esta versión DETECTA si hubo movs durante el conteo y
-- agrega una WARNING al resultado para que el dueño sepa que el ajuste
-- aplicado podría descuadrar el stock real.
--
-- Problema técnico:
--   T0: inicio conteo. snapshot stock_actual=10 → guarda en línea.stock_teorico
--   T1: venta POS de 2. stock_actual=8 (vía trigger).
--   T2: cuento físicamente: 8.
--   T3: finalizo. línea.diferencia = 8-10 = -2. Aplica ajuste -2.
--       stock_actual post = 8 - 2 = 6  ← MAL (debería ser 8)
--
-- Fórmula correcta hubiera sido: ajuste = stock_contado - stock_actual_AL_CERRAR
-- (no contra snapshot). Pero eso rompe el blind count.
--
-- Para fix real: hay que trackear los movs durante el conteo y restarlos
-- del cálculo de ajuste. Eso es ~medio sprint. Por ahora:
--   1. Agregamos columna `movs_durante_conteo` a stock_conteos
--   2. Al finalizar: contar cuántos movs hubo entre iniciado_at y now()
--   3. Si >0, populamos esa columna como advertencia
--   4. UI muestra warning si >0 después de finalizar
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE stock_conteos
  ADD COLUMN IF NOT EXISTS movs_durante_conteo INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN stock_conteos.movs_durante_conteo IS
  'Cantidad de movs (ventas + mermas) que ocurrieron entre iniciado_at y '
  'finalizado_at. Si > 0, el ajuste aplicado puede descuadrar el stock_actual '
  'porque la diferencia se calculó contra el snapshot original, no contra el '
  'stock al cierre. UI debe mostrar warning al dueño en estos casos.';

-- Extender fn_finalizar_conteo_fisico para popular el contador.
-- DROP primero porque cambiamos el return type (agregamos columna).
DROP FUNCTION IF EXISTS public.fn_finalizar_conteo_fisico(BIGINT);

CREATE OR REPLACE FUNCTION public.fn_finalizar_conteo_fisico(p_conteo_id BIGINT)
RETURNS TABLE(ajustes INTEGER, diferencia_valor NUMERIC, movs_durante INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_iniciado_at TIMESTAMPTZ;
  v_ajustes INTEGER := 0;
  v_dif NUMERIC := 0;
  v_movs_durante INTEGER := 0;
  v_linea RECORD;
  v_costo NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT tenant_id, local_id, iniciado_at INTO v_tenant_id, v_local_id, v_iniciado_at
    FROM stock_conteos
   WHERE id = p_conteo_id AND estado = 'abierto';
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'CONTEO_NO_ABIERTO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Aplicar los ajustes (lógica original preservada).
  FOR v_linea IN
    SELECT l.insumo_id, l.diferencia, i.costo_actual
      FROM stock_conteo_lineas l
      INNER JOIN insumos i ON i.id = l.insumo_id
     WHERE l.conteo_id = p_conteo_id
       AND l.stock_contado IS NOT NULL
       AND l.diferencia <> 0
  LOOP
    v_costo := COALESCE(v_linea.costo_actual, 0);
    INSERT INTO insumo_movimientos (
      tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
      motivo, fuente_tipo, fuente_id, usuario_id
    ) VALUES (
      v_tenant_id, v_local_id, v_linea.insumo_id, 'conteo',
      v_linea.diferencia, v_costo,
      'Diferencia conteo físico #' || p_conteo_id,
      'conteo', p_conteo_id, auth_usuario_id()
    );
    v_ajustes := v_ajustes + 1;
    v_dif := v_dif + (v_linea.diferencia * v_costo);
  END LOOP;

  -- NUEVO 26-may: contar movs reales (no 'conteo') que ocurrieron entre
  -- iniciado_at y now(). Si > 0, el snapshot original quedó desincronizado
  -- y el ajuste aplicado puede descuadrar el stock_actual.
  SELECT COUNT(*) INTO v_movs_durante
    FROM insumo_movimientos im
   WHERE im.tenant_id = v_tenant_id
     AND im.local_id = v_local_id
     AND im.created_at BETWEEN v_iniciado_at AND now()
     AND im.tipo IN ('salida_venta', 'merma', 'robo', 'donacion', 'entrada_compra')
     AND COALESCE(im.deleted_at, NULL) IS NULL;

  UPDATE stock_conteos SET
    estado = 'finalizado',
    finalizado_at = NOW(),
    finalizado_por = auth_usuario_id(),
    total_ajustes = v_ajustes,
    valor_diferencia = v_dif,
    movs_durante_conteo = v_movs_durante  -- nuevo campo 26-may
  WHERE id = p_conteo_id;

  RETURN QUERY SELECT v_ajustes, v_dif, v_movs_durante;
END;
$$;

COMMENT ON FUNCTION public.fn_finalizar_conteo_fisico IS
  'Finaliza un conteo físico aplicando los ajustes calculados. Fix 26-may: '
  'ahora también cuenta los movs reales (venta/merma/compra) ocurridos '
  'durante el conteo y los devuelve como `movs_durante`. Si > 0, la UI '
  'debe avisar al dueño que el snapshot quedó desincronizado.';
