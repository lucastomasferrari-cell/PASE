-- 202606110400_aprender_alias_explicit.sql
-- Lucas 10-jun: "no hay una interfaz que permita algún aprendizaje".
-- Fix: el front ahora tiene botón "Pertenece a proveedor X" en las filas
-- rojas; manda prov_id en el item al cerrar la conciliación. El server
-- usa ese prov_id explícito (en vez de derivarlo del mov_id) para
-- aprender el alias titular→proveedor.
--
-- Cambios en fn_cerrar_conciliacion:
-- 1. El INSERT del bloque de APRENDIZAJE ahora chequea primero si el item
--    trae prov_id explícito en el JSON (asignación manual del usuario);
--    si sí, lo usa directo. Si no, cae al LATERAL JOIN existente con el
--    primer mov_id (para flow viejo).
-- 2. El estado_final 'asignada_prov' (nuevo) cuenta como aprendizaje
--    de proveedor.

CREATE OR REPLACE FUNCTION fn_cerrar_conciliacion(
  p_local_id        INTEGER,
  p_periodo_desde   DATE,
  p_periodo_hasta   DATE,
  p_archivo_nombre  TEXT,
  p_totales         JSONB,
  p_saldo_inicial   NUMERIC DEFAULT NULL,
  p_saldo_final     NUMERIC DEFAULT NULL,
  p_movs_conciliados TEXT[] DEFAULT '{}',
  p_items           JSONB DEFAULT '[]'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_usuario_id INTEGER;
  v_corrida_id UUID;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;

  SELECT id INTO v_usuario_id FROM usuarios
  WHERE auth_id = auth.uid() AND tenant_id = v_tenant_id LIMIT 1;

  INSERT INTO conciliacion_corridas (
    tenant_id, local_id, cuenta, periodo_desde, periodo_hasta,
    archivo_nombre, total_movs, verdes, amarillos, rojos_falta, rojos_sobra,
    saldo_inicial_extracto, saldo_final_extracto,
    cerrada_at, cerrada_por, created_by
  ) VALUES (
    v_tenant_id, p_local_id, 'MercadoPago', p_periodo_desde, p_periodo_hasta,
    p_archivo_nombre,
    COALESCE((p_totales->>'total_movs')::INT, 0),
    COALESCE((p_totales->>'verdes')::INT, 0),
    COALESCE((p_totales->>'amarillos')::INT, 0),
    COALESCE((p_totales->>'rojos_falta')::INT, 0),
    COALESCE((p_totales->>'rojos_sobra')::INT, 0),
    p_saldo_inicial, p_saldo_final,
    NOW(), v_usuario_id, v_usuario_id
  ) RETURNING id INTO v_corrida_id;

  UPDATE movimientos SET conciliado_corrida_id = v_corrida_id
  WHERE id = ANY(p_movs_conciliados)
    AND tenant_id = v_tenant_id
    AND local_id = p_local_id
    AND cuenta = 'MercadoPago'
    AND anulado = false
    AND conciliado_corrida_id IS NULL;

  INSERT INTO conciliacion_extracto_items
    (corrida_id, tenant_id, local_id, fecha, monto, descripcion, referencia_externa, estado_final, mov_ids)
  SELECT
    v_corrida_id, v_tenant_id, p_local_id,
    (i->>'fecha')::DATE,
    (i->>'monto')::NUMERIC,
    i->>'descripcion',
    NULLIF(i->>'referencia_externa', ''),
    COALESCE(i->>'estado_final', 'desconocido'),
    CASE WHEN i ? 'mov_ids'
      THEN ARRAY(SELECT jsonb_array_elements_text(i->'mov_ids'))
      ELSE NULL END
  FROM jsonb_array_elements(p_items) AS i;

  -- ── APRENDIZAJE de alias (Lucas 10-jun: solución general + interfaz manual).
  -- Tres caminos:
  --   1. Item con prov_id EXPLÍCITO en el JSON (usuario tocó "Pertenece a X")
  --      → aprende titular → proveedor con ese prov_id.
  --   2. Item con estado_final='creado' (usuario tocó "Crear en Caja")
  --      → aprende titular → gasto_directo.
  --   3. Item con estado 'matcheado/combo/etc' + mov_id que apunta a una
  --      factura/remito → deriva el prov_id y aprende.
  -- 'ignorada' y 'bloque_diferencia' NO enseñan.
  INSERT INTO conciliacion_alias (tenant_id, local_id, titular, tipo, prov_id)
  SELECT DISTINCT ON (t.titular)
    v_tenant_id, p_local_id, t.titular, t.tipo, t.prov_id
  FROM (
    SELECT
      fn_extraer_titular(i->>'descripcion') AS titular,
      CASE
        WHEN (i ? 'prov_id') AND (i->>'prov_id')::INT IS NOT NULL THEN 'proveedor'
        WHEN i->>'estado_final' = 'creado' THEN 'gasto_directo'
        ELSE 'proveedor'
      END AS tipo,
      -- Prioridad: prov_id explícito > derivado por mov_id.
      COALESCE(
        NULLIF(i->>'prov_id', '')::INT,
        prov.prov_id_derivado
      ) AS prov_id,
      i->>'estado_final' AS estado_final
    FROM jsonb_array_elements(p_items) AS i
    LEFT JOIN LATERAL (
      SELECT COALESCE(f.prov_id, r.prov_id) AS prov_id_derivado
      FROM movimientos m
      LEFT JOIN facturas f ON f.id = m.fact_id
      LEFT JOIN remitos r ON r.id = m.remito_id_ref
      WHERE m.id = (ARRAY(SELECT jsonb_array_elements_text(i->'mov_ids')))[1]
      LIMIT 1
    ) prov ON TRUE
  ) t
  WHERE t.titular IS NOT NULL AND LENGTH(t.titular) >= 4
    AND (
      t.estado_final = 'creado'
      OR t.estado_final = 'asignada_prov'  -- asignación manual del usuario
      OR (t.prov_id IS NOT NULL
          AND t.estado_final IN ('verde','matcheado','combo','verde_agrupado','verde_bloque','pagada'))
    )
  ORDER BY t.titular, (t.prov_id IS NULL)
  ON CONFLICT (tenant_id, local_id, titular) DO UPDATE
    SET veces = conciliacion_alias.veces + 1,
        tipo = EXCLUDED.tipo,
        prov_id = EXCLUDED.prov_id,
        updated_at = NOW();

  RETURN jsonb_build_object('id', v_corrida_id, 'created_at', NOW());
END;
$$;

REVOKE ALL ON FUNCTION fn_cerrar_conciliacion(INTEGER, DATE, DATE, TEXT, JSONB, NUMERIC, NUMERIC, TEXT[], JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cerrar_conciliacion(INTEGER, DATE, DATE, TEXT, JSONB, NUMERIC, NUMERIC, TEXT[], JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
