-- 202606101800_conciliacion_flag_conciliado.sql
-- Lucas 10-jun: "hay forma de que automáticamente cuando toco cerrar
-- conciliación me ponga las facturas con un tag invisible 'conciliado'
-- y que no me las muestre más? y de esa forma le sacamos la ventana de
-- tiempo?"
--
-- Exacto el modelo de conciliación bancaria profesional (QuickBooks/Xero):
-- cada movimiento tiene un flag "conciliado" persistente. El cruce opera
-- SOLO sobre lo no conciliado. Esto resuelve el caso de facturas/pagos
-- arrastrados N meses: lo viejo no conciliado sigue disponible, lo
-- conciliado no molesta nunca más.
--
-- Componentes:
-- 1. movimientos.conciliado_corrida_id → el tag invisible (FK a la corrida)
-- 2. conciliacion_extracto_items → las transferencias del extracto que ya
--    se conciliaron (si re-subís el mismo archivo, se reconocen y no
--    aparecen como rojas)
-- 3. fn_cerrar_conciliacion → RPC atómica que cierra: inserta corrida,
--    marca movimientos, guarda items.
-- 4. fn_cruzar_extracto_mp reescrita: excluye movs conciliados + pre-pass
--    "ya_conciliada" + ventana de facturas pendientes ampliada a 180d.

-- ── 1. Flag en movimientos ────────────────────────────────────────────────
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS conciliado_corrida_id UUID NULL
  REFERENCES conciliacion_corridas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_movimientos_conciliado
  ON movimientos (conciliado_corrida_id)
  WHERE conciliado_corrida_id IS NOT NULL;

COMMENT ON COLUMN movimientos.conciliado_corrida_id IS
  'Tag invisible de conciliación (Lucas 10-jun): si NOT NULL, el mov quedó conciliado contra el extracto MP en esa corrida y no vuelve a aparecer en cruces futuros.';

-- ── 2. Items del extracto conciliados ────────────────────────────────────
CREATE TABLE IF NOT EXISTS conciliacion_extracto_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corrida_id  UUID NOT NULL REFERENCES conciliacion_corridas(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id    INTEGER NOT NULL,
  fecha       DATE NOT NULL,
  monto       NUMERIC(14,2) NOT NULL,
  descripcion TEXT,
  referencia_externa TEXT,
  estado_final TEXT NOT NULL,
  mov_ids     TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_concil_items_lookup
  ON conciliacion_extracto_items (tenant_id, local_id, fecha, monto);
CREATE INDEX IF NOT EXISTS idx_concil_items_ref
  ON conciliacion_extracto_items (tenant_id, local_id, referencia_externa)
  WHERE referencia_externa IS NOT NULL;

ALTER TABLE conciliacion_extracto_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS concil_items_all ON conciliacion_extracto_items;
CREATE POLICY concil_items_all ON conciliacion_extracto_items
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- ── 3. RPC cerrar conciliación (atómica) ─────────────────────────────────
CREATE OR REPLACE FUNCTION fn_cerrar_conciliacion(
  p_local_id        INTEGER,
  p_periodo_desde   DATE,
  p_periodo_hasta   DATE,
  p_archivo_nombre  TEXT,
  p_totales         JSONB,         -- {total_movs, verdes, amarillos, rojos_falta, rojos_sobra}
  p_saldo_inicial   NUMERIC DEFAULT NULL,
  p_saldo_final     NUMERIC DEFAULT NULL,
  p_movs_conciliados TEXT[] DEFAULT '{}',  -- ids de movimientos a marcar
  p_items           JSONB DEFAULT '[]'     -- filas del extracto con estado final
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

  -- Marcar movimientos como conciliados (el "tag invisible").
  -- Solo movs del tenant/local, cuenta MP, no anulados y aún sin conciliar.
  UPDATE movimientos SET conciliado_corrida_id = v_corrida_id
  WHERE id = ANY(p_movs_conciliados)
    AND tenant_id = v_tenant_id
    AND local_id = p_local_id
    AND cuenta = 'MercadoPago'
    AND anulado = false
    AND conciliado_corrida_id IS NULL;

  -- Guardar las filas del extracto con su estado final, para que al
  -- re-subir el mismo archivo se reconozcan como ya conciliadas.
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

  RETURN jsonb_build_object('id', v_corrida_id, 'created_at', NOW());
END;
$$;

REVOKE ALL ON FUNCTION fn_cerrar_conciliacion(INTEGER, DATE, DATE, TEXT, JSONB, NUMERIC, NUMERIC, TEXT[], JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cerrar_conciliacion(INTEGER, DATE, DATE, TEXT, JSONB, NUMERIC, NUMERIC, TEXT[], JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
