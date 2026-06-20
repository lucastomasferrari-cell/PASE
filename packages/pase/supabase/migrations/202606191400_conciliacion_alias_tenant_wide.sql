-- Pieza 2 del proyecto "calidad del cruce" (Lucas 19-jun): aliases tenant-wide.
-- Decision Lucas: ADITIVO (no se tocan los ~800 aliases por-local viejos;
-- siguen funcionando). local_id NULL = todos los locales del tenant. Los
-- aliases nuevos (aprendizaje al cerrar + RPC de sugerencia) se guardan global.

ALTER TABLE conciliacion_alias ALTER COLUMN local_id DROP NOT NULL;

ALTER TABLE conciliacion_alias
  DROP CONSTRAINT IF EXISTS conciliacion_alias_tenant_id_local_id_titular_key;
CREATE UNIQUE INDEX IF NOT EXISTS conciliacion_alias_local_uq
  ON conciliacion_alias (tenant_id, local_id, titular) WHERE local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conciliacion_alias_global_uq
  ON conciliacion_alias (tenant_id, titular) WHERE local_id IS NULL;

DROP POLICY IF EXISTS concil_alias_all ON conciliacion_alias;
CREATE POLICY concil_alias_all ON conciliacion_alias
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())));

-- RPC: crear/confirmar alias titular -> proveedor (tenant-wide). La usa la
-- sugerencia proactiva de la UI del cruce.
CREATE OR REPLACE FUNCTION fn_crear_alias_proveedor(p_titular TEXT, p_prov_id INTEGER)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_tenant_id UUID;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('conciliacion')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_CONCILIACION';
  END IF;
  IF p_titular IS NULL OR length(trim(p_titular)) < 4 THEN RAISE EXCEPTION 'TITULAR_INVALIDO'; END IF;
  IF NOT EXISTS (SELECT 1 FROM proveedores WHERE id = p_prov_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'PROVEEDOR_INVALIDO';
  END IF;
  INSERT INTO conciliacion_alias (tenant_id, local_id, titular, tipo, prov_id)
  VALUES (v_tenant_id, NULL, trim(p_titular), 'proveedor', p_prov_id)
  ON CONFLICT (tenant_id, titular) WHERE local_id IS NULL
  DO UPDATE SET tipo='proveedor', prov_id=EXCLUDED.prov_id,
               veces=conciliacion_alias.veces+1, updated_at=NOW();
END;
$fn$;
REVOKE ALL ON FUNCTION fn_crear_alias_proveedor(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_crear_alias_proveedor(TEXT, INTEGER) TO authenticated;

-- Aprendizaje al cerrar conciliacion: ahora guarda los alias como GLOBAL
-- (local_id NULL) para que sirvan en todos los locales.

CREATE OR REPLACE FUNCTION public.fn_cerrar_conciliacion(p_local_id integer, p_periodo_desde date, p_periodo_hasta date, p_archivo_nombre text, p_totales jsonb, p_saldo_inicial numeric DEFAULT NULL::numeric, p_saldo_final numeric DEFAULT NULL::numeric, p_movs_conciliados text[] DEFAULT '{}'::text[], p_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    v_tenant_id, NULL::INTEGER, t.titular, t.tipo, t.prov_id
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
  ON CONFLICT (tenant_id, titular) WHERE local_id IS NULL DO UPDATE
    SET veces = conciliacion_alias.veces + 1,
        tipo = EXCLUDED.tipo,
        prov_id = EXCLUDED.prov_id,
        updated_at = NOW();

  RETURN jsonb_build_object('id', v_corrida_id, 'created_at', NOW());
END;
$function$
;

REVOKE ALL ON FUNCTION fn_cerrar_conciliacion(INTEGER, DATE, DATE, TEXT, JSONB, NUMERIC, NUMERIC, TEXT[], JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cerrar_conciliacion(INTEGER, DATE, DATE, TEXT, JSONB, NUMERIC, NUMERIC, TEXT[], JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
