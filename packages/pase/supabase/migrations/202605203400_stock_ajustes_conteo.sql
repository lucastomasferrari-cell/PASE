-- ═══════════════════════════════════════════════════════════════════════════
-- Ajustes manuales + Conteo físico + Alertas
--
-- RPCs:
--   - fn_ajustar_stock_insumo  → ajuste con motivo (merma, robo, etc)
--   - fn_iniciar_conteo_fisico → crea sesión de conteo (snapshot teórico)
--   - fn_finalizar_conteo_fisico → aplica diferencias detectadas
--
-- Vistas:
--   - v_insumos_alertas_stock → insumos con stock < stock_minimo
--   - v_stock_rotacion_30d    → cuánto rotó cada insumo en últimos 30 días
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Tabla stock_conteos ──────────────────────────────────────────────────
-- Una sesión de conteo agrupa el snapshot teórico inicial y el resultado
-- real. Cuando se "finaliza", se aplican los movimientos `conteo` por las
-- diferencias detectadas.
CREATE TABLE IF NOT EXISTS stock_conteos (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  local_id        INTEGER NOT NULL,
  iniciado_por    INTEGER NOT NULL,
  finalizado_por  INTEGER,
  estado          TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'finalizado', 'cancelado')),
  notas           TEXT,
  iniciado_at     TIMESTAMPTZ DEFAULT NOW(),
  finalizado_at   TIMESTAMPTZ,
  -- Snapshot del stock total al iniciar (para calcular diferencia neta del conteo)
  total_insumos   INTEGER DEFAULT 0,
  total_ajustes   INTEGER DEFAULT 0,
  valor_diferencia NUMERIC(14, 2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conteos_tenant_local
  ON stock_conteos(tenant_id, local_id, iniciado_at DESC);

ALTER TABLE stock_conteos ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_conteos_all ON stock_conteos
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- Tabla de líneas del conteo: insumo + teórico + contado + diff
CREATE TABLE IF NOT EXISTS stock_conteo_lineas (
  id                BIGSERIAL PRIMARY KEY,
  conteo_id         BIGINT NOT NULL REFERENCES stock_conteos(id) ON DELETE CASCADE,
  insumo_id         BIGINT NOT NULL REFERENCES insumos(id),
  stock_teorico     NUMERIC(12, 4) NOT NULL,
  stock_contado     NUMERIC(12, 4),
  diferencia        NUMERIC(12, 4) GENERATED ALWAYS AS (stock_contado - stock_teorico) STORED,
  notas             TEXT,
  contado_at        TIMESTAMPTZ,
  contado_por       INTEGER,
  UNIQUE(conteo_id, insumo_id)
);
CREATE INDEX IF NOT EXISTS idx_conteo_lineas_conteo
  ON stock_conteo_lineas(conteo_id);

ALTER TABLE stock_conteo_lineas ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_conteo_lineas_all ON stock_conteo_lineas
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stock_conteos c
       WHERE c.id = stock_conteo_lineas.conteo_id
         AND c.tenant_id = auth_tenant_id()
         AND (auth_es_dueno_o_admin() OR c.local_id = ANY(auth_locales_visibles()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stock_conteos c
       WHERE c.id = stock_conteo_lineas.conteo_id
         AND c.tenant_id = auth_tenant_id()
         AND (auth_es_dueno_o_admin() OR c.local_id = ANY(auth_locales_visibles()))
    )
  );

-- ─── RPC: Ajuste manual con motivo ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_ajustar_stock_insumo(
  p_insumo_id BIGINT,
  p_cantidad NUMERIC,           -- positivo = entrada, negativo = salida
  p_tipo TEXT,                  -- entrada_ajuste | salida_ajuste | merma | robo | donacion
  p_motivo TEXT,
  p_manager_id INTEGER DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_costo NUMERIC(12, 4);
  v_mov_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_cantidad = 0 THEN RAISE EXCEPTION 'CANTIDAD_INVALIDA'; END IF;
  IF p_tipo NOT IN ('entrada_ajuste','salida_ajuste','merma','robo','donacion') THEN
    RAISE EXCEPTION 'TIPO_AJUSTE_INVALIDO';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;
  -- robo + donacion requieren manager_id (operación sensible)
  IF p_tipo IN ('robo', 'donacion') AND p_manager_id IS NULL THEN
    RAISE EXCEPTION 'MANAGER_REQUERIDO_PARA_TIPO';
  END IF;

  SELECT tenant_id, local_id, costo_actual
    INTO v_tenant_id, v_local_id, v_costo
    FROM insumos
   WHERE id = p_insumo_id AND deleted_at IS NULL;
  IF v_local_id IS NULL AND v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO';
  END IF;

  -- Validar permisos (insumos globales: solo dueño/admin)
  IF v_local_id IS NULL THEN
    IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'PERMISO_DENEGADO'; END IF;
  ELSE
    IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
      RAISE EXCEPTION 'PERMISO_DENEGADO';
    END IF;
  END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario, motivo,
    usuario_id, manager_id
  ) VALUES (
    v_tenant_id, v_local_id, p_insumo_id, p_tipo,
    p_cantidad, v_costo, trim(p_motivo),
    auth.uid()::INTEGER, p_manager_id
  ) RETURNING id INTO v_mov_id;

  RETURN v_mov_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_ajustar_stock_insumo(BIGINT, NUMERIC, TEXT, TEXT, INTEGER) TO authenticated;

-- ─── RPC: Iniciar conteo físico ───────────────────────────────────────────
-- Snapshot del stock teórico actual. Genera una fila por insumo del local.
CREATE OR REPLACE FUNCTION fn_iniciar_conteo_fisico(
  p_local_id INTEGER,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_conteo_id BIGINT;
  v_count INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- No permitir dos conteos abiertos simultáneos en el mismo local
  IF EXISTS (
    SELECT 1 FROM stock_conteos
     WHERE local_id = p_local_id AND tenant_id = v_tenant_id AND estado = 'abierto'
  ) THEN
    RAISE EXCEPTION 'CONTEO_YA_ABIERTO';
  END IF;

  INSERT INTO stock_conteos (tenant_id, local_id, iniciado_por, notas)
  VALUES (v_tenant_id, p_local_id, auth.uid()::INTEGER, p_notas)
  RETURNING id INTO v_conteo_id;

  -- Crear una línea por cada insumo activo del local (global + local-specific)
  INSERT INTO stock_conteo_lineas (conteo_id, insumo_id, stock_teorico)
  SELECT v_conteo_id, i.id, COALESCE(i.stock_actual, 0)
    FROM insumos i
   WHERE i.tenant_id = v_tenant_id
     AND i.activo = TRUE
     AND i.deleted_at IS NULL
     AND (i.local_id IS NULL OR i.local_id = p_local_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE stock_conteos SET total_insumos = v_count WHERE id = v_conteo_id;

  RETURN v_conteo_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_iniciar_conteo_fisico(INTEGER, TEXT) TO authenticated;

-- ─── RPC: Finalizar conteo físico → aplicar diferencias como movimientos ──
CREATE OR REPLACE FUNCTION fn_finalizar_conteo_fisico(p_conteo_id BIGINT)
RETURNS TABLE (ajustes INTEGER, diferencia_valor NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_ajustes INTEGER := 0;
  v_dif NUMERIC := 0;
  v_linea RECORD;
  v_costo NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT tenant_id, local_id INTO v_tenant_id, v_local_id
    FROM stock_conteos
   WHERE id = p_conteo_id AND estado = 'abierto';
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'CONTEO_NO_ABIERTO'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Para cada línea con stock_contado != NULL y diferencia != 0, crear movimiento
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
      'conteo', p_conteo_id, auth.uid()::INTEGER
    );
    v_ajustes := v_ajustes + 1;
    v_dif := v_dif + (v_linea.diferencia * v_costo);
  END LOOP;

  UPDATE stock_conteos SET
    estado = 'finalizado',
    finalizado_at = NOW(),
    finalizado_por = auth.uid()::INTEGER,
    total_ajustes = v_ajustes,
    valor_diferencia = v_dif
  WHERE id = p_conteo_id;

  RETURN QUERY SELECT v_ajustes, v_dif;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_finalizar_conteo_fisico(BIGINT) TO authenticated;

-- ─── RPC: Cargar cantidad contada en una línea ────────────────────────────
CREATE OR REPLACE FUNCTION fn_cargar_conteo_linea(
  p_conteo_id BIGINT,
  p_insumo_id BIGINT,
  p_stock_contado NUMERIC,
  p_notas TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_local_id INTEGER;
BEGIN
  SELECT local_id INTO v_local_id FROM stock_conteos
   WHERE id = p_conteo_id AND estado = 'abierto' AND tenant_id = auth_tenant_id();
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'CONTEO_NO_ABIERTO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  IF p_stock_contado < 0 THEN RAISE EXCEPTION 'STOCK_NEGATIVO'; END IF;

  UPDATE stock_conteo_lineas SET
    stock_contado = p_stock_contado,
    notas = p_notas,
    contado_at = NOW(),
    contado_por = auth.uid()::INTEGER
  WHERE conteo_id = p_conteo_id AND insumo_id = p_insumo_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_cargar_conteo_linea(BIGINT, BIGINT, NUMERIC, TEXT) TO authenticated;

-- ─── Vista: alertas de stock bajo ─────────────────────────────────────────
CREATE OR REPLACE VIEW v_insumos_alertas_stock AS
SELECT
  i.id,
  i.tenant_id,
  i.local_id,
  i.nombre,
  i.unidad,
  i.emoji,
  i.stock_actual,
  i.stock_minimo,
  i.stock_maximo,
  i.costo_actual,
  CASE
    WHEN i.stock_minimo IS NOT NULL AND i.stock_actual <= 0 THEN 'agotado'
    WHEN i.stock_minimo IS NOT NULL AND i.stock_actual < i.stock_minimo THEN 'bajo'
    WHEN i.stock_maximo IS NOT NULL AND i.stock_actual > i.stock_maximo THEN 'sobrestock'
    ELSE 'ok'
  END AS alerta_nivel,
  -- "días que aguanta" estimado: stock_actual / (consumo_promedio_diario_30d)
  CASE
    WHEN i.stock_actual > 0 THEN
      i.stock_actual / NULLIF((
        SELECT (-SUM(im.cantidad)) / 30.0
          FROM insumo_movimientos im
         WHERE im.insumo_id = i.id
           AND im.tipo = 'salida_venta'
           AND im.created_at > NOW() - INTERVAL '30 days'
           AND im.deleted_at IS NULL
      ), 0)
    ELSE 0
  END AS dias_estimados_restantes
FROM insumos i
WHERE i.deleted_at IS NULL
  AND i.activo = TRUE;

GRANT SELECT ON v_insumos_alertas_stock TO authenticated;

-- ─── Vista: rotación 30 días ──────────────────────────────────────────────
-- ABS de un sum agregado se calcula con CASE — no se puede envolver el
-- aggregate con función escalar y aplicar FILTER después.
CREATE OR REPLACE VIEW v_stock_rotacion_30d AS
SELECT
  i.id AS insumo_id,
  i.tenant_id,
  i.local_id,
  i.nombre,
  i.unidad,
  i.costo_actual,
  i.stock_actual,
  -- consumido = -SUM de salidas_venta (la cantidad es negativa, así que la negamos)
  COALESCE(-SUM(im.cantidad) FILTER (WHERE im.tipo = 'salida_venta'), 0) AS consumido_30d,
  COALESCE(-SUM(im.cantidad) FILTER (WHERE im.tipo IN ('merma','robo','donacion')), 0) AS perdido_30d,
  COALESCE(SUM(im.cantidad) FILTER (WHERE im.tipo IN ('entrada_compra','entrada_ajuste','entrada_devolucion')), 0) AS comprado_30d,
  COALESCE(-SUM(im.cantidad) FILTER (WHERE im.tipo = 'salida_venta'), 0) * COALESCE(i.costo_actual, 0) AS valor_consumido_30d
FROM insumos i
LEFT JOIN insumo_movimientos im
  ON im.insumo_id = i.id
  AND im.created_at > NOW() - INTERVAL '30 days'
  AND im.deleted_at IS NULL
WHERE i.deleted_at IS NULL
GROUP BY i.id, i.tenant_id, i.local_id, i.nombre, i.unidad, i.costo_actual, i.stock_actual;

GRANT SELECT ON v_stock_rotacion_30d TO authenticated;

NOTIFY pgrst, 'reload schema';
