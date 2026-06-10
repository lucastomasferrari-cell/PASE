-- 202606100100_conciliacion_extracto_mp.sql
-- Módulo nuevo "Conciliación" (Lucas 10-jun): conciliar el extracto mensual
-- de MercadoPago (XLSX/CSV/PDF) contra los movimientos cargados en PASE
-- para la cuenta "MercadoPago" del local activo.
--
-- Modelo:
-- 1. User sube el archivo → frontend parsea → obtiene array de movs
-- 2. RPC fn_cruzar_extracto_mp recibe el array + local_id, lo cruza
--    contra `movimientos` (cuenta='MercadoPago' del local) usando regla:
--      - monto EXACTO (al centavo) — bloqueante
--      - fecha en ventana ±15 días desde la fecha del extracto
--    Devuelve JSON con semáforo: verde/amarillo/rojo+falta/rojo+sobra
-- 3. User resuelve cada caso desde la UI:
--      - Falta en PASE  → botón Crear (llama crear_movimiento_caja)
--      - Sobra en PASE  → botón Anular (llama anular_movimiento)
--      - Amarillo (múltiples candidatos) → elige cuál y confirma
-- 4. User toca "Cerrar conciliación" → INSERT en conciliacion_corridas
--    con metadata (archivo, período, contadores). Es solo registro
--    histórico — el estado real vive en las tablas movimientos.

CREATE TABLE IF NOT EXISTS conciliacion_corridas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id        INTEGER NOT NULL REFERENCES locales(id),
  cuenta          TEXT NOT NULL DEFAULT 'MercadoPago',
  periodo_desde   DATE NOT NULL,
  periodo_hasta   DATE NOT NULL,
  archivo_nombre  TEXT,
  total_movs      INTEGER NOT NULL DEFAULT 0,
  verdes          INTEGER NOT NULL DEFAULT 0,
  amarillos       INTEGER NOT NULL DEFAULT 0,
  rojos_falta     INTEGER NOT NULL DEFAULT 0, -- en extracto pero no en PASE
  rojos_sobra     INTEGER NOT NULL DEFAULT 0, -- en PASE pero no en extracto
  saldo_inicial_extracto NUMERIC(14,2),
  saldo_final_extracto   NUMERIC(14,2),
  observaciones   TEXT,
  cerrada_at      TIMESTAMPTZ,
  cerrada_por     INTEGER REFERENCES usuarios(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INTEGER REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_conciliacion_corridas_tenant_local
  ON conciliacion_corridas (tenant_id, local_id, periodo_desde DESC);

ALTER TABLE conciliacion_corridas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conciliacion_corridas_all ON conciliacion_corridas;
CREATE POLICY conciliacion_corridas_all ON conciliacion_corridas
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (
      auth_es_dueno_o_admin()
      OR local_id = ANY(auth_locales_visibles())
    )
  );

-- RPC: recibe los movs del extracto parseado (array JSON) + local_id.
-- Devuelve para cada mov del extracto un objeto:
--   { fecha, monto, descripcion, referencia_externa, estado, candidatos }
-- estado ∈ ('verde', 'amarillo', 'rojo_falta')
-- candidatos = array de movs de PASE que coinciden (1 si verde, N si amarillo)
-- Adicionalmente devuelve los movs de PASE que SOBRAN (rojos_sobra) —
-- están en PASE pero no en el extracto.
CREATE OR REPLACE FUNCTION fn_cruzar_extracto_mp(
  p_local_id   INTEGER,
  p_periodo_desde DATE,
  p_periodo_hasta DATE,
  p_movs_extracto JSONB  -- [{fecha:"YYYY-MM-DD", monto:Number, descripcion:Text, referencia_externa:Text|null}]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id   UUID;
  v_resultado   JSONB;
  v_extracto_count INTEGER;
  v_ventana_desde DATE;
  v_ventana_hasta DATE;
BEGIN
  -- Auth check (regla C11)
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;
  -- Verificar acceso al local
  IF NOT auth_es_dueno_o_admin()
     AND NOT (p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO';
  END IF;

  v_extracto_count := COALESCE(jsonb_array_length(p_movs_extracto), 0);
  -- Ventana de búsqueda en PASE: período del extracto ± 15 días
  v_ventana_desde := p_periodo_desde - INTERVAL '15 days';
  v_ventana_hasta := p_periodo_hasta + INTERVAL '15 days';

  -- A) Cruzar cada mov del extracto contra movimientos de PASE
  WITH extracto AS (
    SELECT
      (e->>'fecha')::DATE                     AS fecha,
      (e->>'monto')::NUMERIC                  AS monto,
      COALESCE(e->>'descripcion', '')         AS descripcion,
      NULLIF(e->>'referencia_externa', '')    AS referencia_externa,
      ordinality - 1                          AS idx
    FROM jsonb_array_elements(p_movs_extracto) WITH ORDINALITY AS t(e, ordinality)
  ),
  movs_pase AS (
    -- conciliado_at no existe en movimientos; lo dejamos NULL siempre.
    -- Si en el futuro agregamos tracking de conciliación, acá se pobla.
    SELECT id, fecha, importe, detalle, cuenta, anulado,
           NULL::TIMESTAMPTZ AS conciliado_at
    FROM movimientos
    WHERE tenant_id = v_tenant_id
      AND local_id = p_local_id
      AND cuenta = 'MercadoPago'
      AND anulado = false
      AND fecha BETWEEN v_ventana_desde AND v_ventana_hasta
  ),
  -- Para cada mov del extracto, encontrar todos los movs de PASE que matchean
  -- (mismo monto, fecha en ventana ±15d)
  candidatos AS (
    SELECT
      e.idx                                                   AS extracto_idx,
      e.fecha                                                 AS extracto_fecha,
      e.monto                                                 AS extracto_monto,
      e.descripcion                                           AS extracto_descripcion,
      e.referencia_externa                                    AS extracto_referencia,
      m.id                                                    AS mov_id,
      m.fecha                                                 AS mov_fecha,
      m.importe                                               AS mov_importe,
      m.detalle                                               AS mov_detalle,
      m.conciliado_at                                         AS mov_conciliado_at,
      ABS(EXTRACT(EPOCH FROM (m.fecha::TIMESTAMP - e.fecha::TIMESTAMP)) / 86400)::INTEGER AS dias_diff
    FROM extracto e
    LEFT JOIN movs_pase m
      ON m.importe = e.monto
      AND ABS(m.fecha - e.fecha) <= 15
  ),
  -- Agrupar candidatos por mov del extracto
  por_extracto AS (
    SELECT
      extracto_idx,
      extracto_fecha,
      extracto_monto,
      extracto_descripcion,
      extracto_referencia,
      COUNT(mov_id) FILTER (WHERE mov_id IS NOT NULL) AS num_candidatos,
      jsonb_agg(
        CASE WHEN mov_id IS NOT NULL THEN
          jsonb_build_object(
            'id', mov_id,
            'fecha', mov_fecha,
            'importe', mov_importe,
            'detalle', mov_detalle,
            'dias_diff', dias_diff,
            'ya_conciliado', mov_conciliado_at IS NOT NULL
          )
        ELSE NULL END
      ) FILTER (WHERE mov_id IS NOT NULL) AS candidatos
    FROM candidatos
    GROUP BY extracto_idx, extracto_fecha, extracto_monto, extracto_descripcion, extracto_referencia
  ),
  cruzados AS (
    SELECT
      extracto_idx,
      jsonb_build_object(
        'idx', extracto_idx,
        'fecha', extracto_fecha,
        'monto', extracto_monto,
        'descripcion', extracto_descripcion,
        'referencia_externa', extracto_referencia,
        'estado', CASE
          WHEN num_candidatos = 0 THEN 'rojo_falta'
          WHEN num_candidatos = 1 THEN 'verde'
          ELSE 'amarillo'
        END,
        'num_candidatos', num_candidatos,
        'candidatos', COALESCE(candidatos, '[]'::jsonb)
      ) AS row_json
    FROM por_extracto
  ),
  -- B) Movs de PASE que SOBRAN (están en PASE en el período pero no
  -- aparecen en el extracto). Match por monto exacto: si en el extracto
  -- NO existe ningún mov con ese monto+fecha cerca, sobra.
  ids_matcheados AS (
    SELECT DISTINCT mov_id FROM candidatos WHERE mov_id IS NOT NULL
  ),
  sobrantes AS (
    SELECT id, fecha, importe, detalle
    FROM movs_pase
    WHERE fecha BETWEEN p_periodo_desde AND p_periodo_hasta
      AND id NOT IN (SELECT mov_id FROM ids_matcheados WHERE mov_id IS NOT NULL)
  )
  SELECT jsonb_build_object(
    'extracto', COALESCE(
      (SELECT jsonb_agg(row_json ORDER BY extracto_idx) FROM cruzados),
      '[]'::jsonb
    ),
    'sobrantes', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'fecha', fecha, 'importe', importe, 'detalle', detalle
      ) ORDER BY fecha DESC) FROM sobrantes),
      '[]'::jsonb
    ),
    'totales', jsonb_build_object(
      'extracto_total',  v_extracto_count,
      'verdes',          (SELECT COUNT(*) FROM cruzados WHERE row_json->>'estado' = 'verde'),
      'amarillos',       (SELECT COUNT(*) FROM cruzados WHERE row_json->>'estado' = 'amarillo'),
      'rojos_falta',     (SELECT COUNT(*) FROM cruzados WHERE row_json->>'estado' = 'rojo_falta'),
      'rojos_sobra',     (SELECT COUNT(*) FROM sobrantes)
    )
  ) INTO v_resultado;

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB) TO authenticated;

COMMENT ON TABLE conciliacion_corridas IS
  'Histórico de conciliaciones de extracto MP por local + período. Una fila por archivo subido y cerrado (Lucas 10-jun).';

COMMENT ON FUNCTION fn_cruzar_extracto_mp IS
  'Cruza movs del extracto MP contra movimientos.cuenta=MercadoPago del local. Match: monto exacto + fecha ±15d. Retorna semáforo verde/amarillo/rojo_falta/rojo_sobra.';

NOTIFY pgrst, 'reload schema';
