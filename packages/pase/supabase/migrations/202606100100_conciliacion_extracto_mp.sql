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
  p_movs_extracto JSONB,  -- [{fecha:"YYYY-MM-DD", monto:Number, descripcion:Text, referencia_externa:Text|null}]
  -- Lucas 10-jun: por default SOLO conciliamos egresos. Las liquidaciones
  -- de venta, rendimientos y transferencias recibidas son ingresos que
  -- vienen por otra vía (POS, intereses automáticos) y son cientos por
  -- mes — no tiene sentido cruzarlos uno por uno. Si true, filtra el
  -- extracto a monto<0 Y los movs de PASE a importe<0 también.
  p_solo_egresos BOOLEAN DEFAULT TRUE,
  -- Lucas 10-jun: Anto suele pagar VARIAS facturas del mismo proveedor en
  -- UNA sola transferencia. El match 1-a-1 falla (3 facturas de $100k cada
  -- una vs 1 transferencia de $300k). Si true, los rojo_falta intentan
  -- match agrupado: combinaciones de 2 a 5 movs del MISMO proveedor en
  -- ventana ±30d que sumen el monto del extracto exacto al centavo.
  p_match_agrupado BOOLEAN DEFAULT TRUE
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
  v_ventana_agrupada_desde DATE;
  v_ventana_agrupada_hasta DATE;
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

  -- Conteo del extracto post-filtro (solo egresos si aplica).
  IF p_solo_egresos THEN
    SELECT COUNT(*) INTO v_extracto_count
    FROM jsonb_array_elements(p_movs_extracto) AS e
    WHERE (e->>'monto')::NUMERIC < 0;
  ELSE
    v_extracto_count := COALESCE(jsonb_array_length(p_movs_extracto), 0);
  END IF;
  -- Ventana de búsqueda en PASE: período del extracto ± 15 días
  v_ventana_desde := p_periodo_desde - INTERVAL '15 days';
  v_ventana_hasta := p_periodo_hasta + INTERVAL '15 days';
  -- Ventana extendida para matching agrupado: ±30d (Lucas: las facturas
  -- pueden ser mucho más viejas que el pago).
  v_ventana_agrupada_desde := p_periodo_desde - INTERVAL '30 days';
  v_ventana_agrupada_hasta := p_periodo_hasta + INTERVAL '30 days';

  -- Limpiar temp por si quedó de invocación anterior (no transaccional)
  DROP TABLE IF EXISTS _concil_tmp;

  -- ── PASS 1: matching individual 1-a-1 (mismo monto, fecha ±15d) ──────
  CREATE TEMP TABLE _concil_tmp AS
  WITH extracto AS (
    SELECT
      (e->>'fecha')::DATE                     AS fecha,
      (e->>'monto')::NUMERIC                  AS monto,
      COALESCE(e->>'descripcion', '')         AS descripcion,
      NULLIF(e->>'referencia_externa', '')    AS referencia_externa,
      ordinality - 1                          AS idx
    FROM jsonb_array_elements(p_movs_extracto) WITH ORDINALITY AS t(e, ordinality)
    WHERE (NOT p_solo_egresos OR (e->>'monto')::NUMERIC < 0)
  ),
  movs_pase AS (
    SELECT id, fecha, importe, detalle, cuenta, anulado,
           fact_id,
           NULL::TIMESTAMPTZ AS conciliado_at
    FROM movimientos
    WHERE tenant_id = v_tenant_id
      AND local_id = p_local_id
      AND cuenta = 'MercadoPago'
      AND anulado = false
      AND fecha BETWEEN v_ventana_agrupada_desde AND v_ventana_agrupada_hasta
      AND (NOT p_solo_egresos OR importe < 0)
  ),
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
      ABS((m.fecha - e.fecha))::INTEGER                       AS dias_diff
    FROM extracto e
    LEFT JOIN movs_pase m
      ON m.importe = e.monto
      AND ABS(m.fecha - e.fecha) <= 15
  )
  SELECT
    extracto_idx,
    extracto_fecha,
    extracto_monto,
    extracto_descripcion,
    extracto_referencia,
    COUNT(mov_id) FILTER (WHERE mov_id IS NOT NULL) AS num_candidatos,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', mov_id, 'fecha', mov_fecha, 'importe', mov_importe,
          'detalle', mov_detalle, 'dias_diff', dias_diff,
          'ya_conciliado', mov_conciliado_at IS NOT NULL
        )
      ) FILTER (WHERE mov_id IS NOT NULL),
      '[]'::jsonb
    ) AS candidatos,
    '[]'::jsonb AS combinaciones
  FROM candidatos
  GROUP BY extracto_idx, extracto_fecha, extracto_monto, extracto_descripcion, extracto_referencia;

  -- ── PASS 2: matching agrupado por proveedor (subset-sum) ──────────────
  -- Para cada fila del extracto que NO tuvo match individual, buscar
  -- combinaciones de 2 a 5 movs del MISMO proveedor en ventana ±30d que
  -- sumen exacto. Filtro por proveedor evita falsos positivos (sino el
  -- subset-sum encontraría matchs casuales por suerte).
  --
  -- Algoritmo: por cada extracto_idx con num_candidatos=0, por cada
  -- proveedor con >=2 movs en ventana, generamos todas las combinaciones
  -- de tamaños 2..5 con un join lateral. Si la suma == monto target,
  -- agregamos al array de combinaciones.
  --
  -- Usamos plpgsql procedural para mantener legibilidad.
  DECLARE
    v_ext      RECORD;
    v_prov     RECORD;
    v_movs_arr JSONB[];
    v_mov_amounts NUMERIC[];
    v_n        INT;
    i1 INT; i2 INT; i3 INT; i4 INT; i5 INT;
    v_suma     NUMERIC;
    v_combo    JSONB;
    v_combos_para_ext JSONB;
  BEGIN
    IF p_match_agrupado THEN
      -- Loop por filas del extracto sin match individual
      FOR v_ext IN
        SELECT extracto_idx, extracto_monto
        FROM _concil_tmp
        WHERE num_candidatos = 0
      LOOP
        v_combos_para_ext := '[]'::jsonb;

        -- Loop por proveedor con >= 2 movs en ventana ±30d
        FOR v_prov IN
          SELECT f.prov_id, p.nombre AS prov_nombre, COUNT(*) AS n_movs
          FROM movimientos m
          JOIN facturas f ON f.id = m.fact_id
          LEFT JOIN proveedores p ON p.id = f.prov_id
          WHERE m.tenant_id = v_tenant_id
            AND m.local_id = p_local_id
            AND m.cuenta = 'MercadoPago'
            AND m.anulado = false
            AND m.fecha BETWEEN v_ventana_agrupada_desde AND v_ventana_agrupada_hasta
            AND m.importe < 0
            AND f.prov_id IS NOT NULL
          GROUP BY f.prov_id, p.nombre
          HAVING COUNT(*) >= 2
        LOOP
          -- Traer los movs de este proveedor en un array ordenado por fecha
          -- (limitamos a 10 para no explotar el espacio de combinaciones)
          SELECT
            array_agg(j ORDER BY (j->>'fecha')::DATE),
            array_agg((j->>'importe')::NUMERIC ORDER BY (j->>'fecha')::DATE)
          INTO v_movs_arr, v_mov_amounts
          FROM (
            SELECT jsonb_build_object(
              'id', m.id, 'fecha', m.fecha, 'importe', m.importe, 'detalle', m.detalle
            ) AS j
            FROM movimientos m
            JOIN facturas f ON f.id = m.fact_id
            WHERE m.tenant_id = v_tenant_id
              AND m.local_id = p_local_id
              AND m.cuenta = 'MercadoPago'
              AND m.anulado = false
              AND m.fecha BETWEEN v_ventana_agrupada_desde AND v_ventana_agrupada_hasta
              AND m.importe < 0
              AND f.prov_id = v_prov.prov_id
            ORDER BY m.fecha
            LIMIT 10
          ) sub;

          v_n := COALESCE(array_length(v_movs_arr, 1), 0);
          IF v_n < 2 THEN CONTINUE; END IF;

          DECLARE
            v_mov_jsons JSONB[] := v_movs_arr;
          BEGIN

            -- Tamaño 2
            FOR i1 IN 1..v_n LOOP
              FOR i2 IN (i1+1)..v_n LOOP
                v_suma := v_mov_amounts[i1] + v_mov_amounts[i2];
                IF v_suma = v_ext.extracto_monto THEN
                  v_combo := jsonb_build_object(
                    'proveedor', v_prov.prov_nombre,
                    'num_movs', 2,
                    'movs', jsonb_build_array(v_mov_jsons[i1], v_mov_jsons[i2])
                  );
                  v_combos_para_ext := v_combos_para_ext || v_combo;
                END IF;
              END LOOP;
            END LOOP;

            -- Tamaño 3
            IF v_n >= 3 THEN
              FOR i1 IN 1..v_n LOOP
                FOR i2 IN (i1+1)..v_n LOOP
                  FOR i3 IN (i2+1)..v_n LOOP
                    v_suma := v_mov_amounts[i1] + v_mov_amounts[i2] + v_mov_amounts[i3];
                    IF v_suma = v_ext.extracto_monto THEN
                      v_combo := jsonb_build_object(
                        'proveedor', v_prov.prov_nombre,
                        'num_movs', 3,
                        'movs', jsonb_build_array(v_mov_jsons[i1], v_mov_jsons[i2], v_mov_jsons[i3])
                      );
                      v_combos_para_ext := v_combos_para_ext || v_combo;
                    END IF;
                  END LOOP;
                END LOOP;
              END LOOP;
            END IF;

            -- Tamaño 4
            IF v_n >= 4 THEN
              FOR i1 IN 1..v_n LOOP
                FOR i2 IN (i1+1)..v_n LOOP
                  FOR i3 IN (i2+1)..v_n LOOP
                    FOR i4 IN (i3+1)..v_n LOOP
                      v_suma := v_mov_amounts[i1] + v_mov_amounts[i2] + v_mov_amounts[i3] + v_mov_amounts[i4];
                      IF v_suma = v_ext.extracto_monto THEN
                        v_combo := jsonb_build_object(
                          'proveedor', v_prov.prov_nombre,
                          'num_movs', 4,
                          'movs', jsonb_build_array(v_mov_jsons[i1], v_mov_jsons[i2], v_mov_jsons[i3], v_mov_jsons[i4])
                        );
                        v_combos_para_ext := v_combos_para_ext || v_combo;
                      END IF;
                    END LOOP;
                  END LOOP;
                END LOOP;
              END LOOP;
            END IF;

            -- Tamaño 5
            IF v_n >= 5 THEN
              FOR i1 IN 1..v_n LOOP
                FOR i2 IN (i1+1)..v_n LOOP
                  FOR i3 IN (i2+1)..v_n LOOP
                    FOR i4 IN (i3+1)..v_n LOOP
                      FOR i5 IN (i4+1)..v_n LOOP
                        v_suma := v_mov_amounts[i1] + v_mov_amounts[i2] + v_mov_amounts[i3] + v_mov_amounts[i4] + v_mov_amounts[i5];
                        IF v_suma = v_ext.extracto_monto THEN
                          v_combo := jsonb_build_object(
                            'proveedor', v_prov.prov_nombre,
                            'num_movs', 5,
                            'movs', jsonb_build_array(v_mov_jsons[i1], v_mov_jsons[i2], v_mov_jsons[i3], v_mov_jsons[i4], v_mov_jsons[i5])
                          );
                          v_combos_para_ext := v_combos_para_ext || v_combo;
                        END IF;
                      END LOOP;
                    END LOOP;
                  END LOOP;
                END LOOP;
              END LOOP;
            END IF;
          END;
        END LOOP;

        -- Guardar las combinaciones encontradas en la fila tmp
        IF jsonb_array_length(v_combos_para_ext) > 0 THEN
          UPDATE _concil_tmp
            SET combinaciones = v_combos_para_ext
          WHERE extracto_idx = v_ext.extracto_idx;
        END IF;
      END LOOP;
    END IF;
  END;

  -- ── PASS 3: armar resultado final ────────────────────────────────────
  -- Calcular ids que YA están "matcheados" (individual o agrupado) para
  -- excluirlos de sobrantes.
  WITH ids_individuales AS (
    SELECT DISTINCT (c->>'id')::TEXT AS mov_id
    FROM _concil_tmp t, jsonb_array_elements(t.candidatos) c
    WHERE c->>'id' IS NOT NULL
  ),
  ids_agrupados AS (
    SELECT DISTINCT (m->>'id')::TEXT AS mov_id
    FROM _concil_tmp t,
         jsonb_array_elements(t.combinaciones) combo,
         jsonb_array_elements(combo->'movs') m
    WHERE m->>'id' IS NOT NULL
  ),
  ids_matcheados AS (
    SELECT mov_id FROM ids_individuales
    UNION
    SELECT mov_id FROM ids_agrupados
  ),
  sobrantes AS (
    SELECT m.id, m.fecha, m.importe, m.detalle
    FROM movimientos m
    WHERE m.tenant_id = v_tenant_id
      AND m.local_id = p_local_id
      AND m.cuenta = 'MercadoPago'
      AND m.anulado = false
      AND m.fecha BETWEEN p_periodo_desde AND p_periodo_hasta
      AND (NOT p_solo_egresos OR m.importe < 0)
      AND m.id NOT IN (SELECT mov_id FROM ids_matcheados WHERE mov_id IS NOT NULL)
  ),
  filas_finales AS (
    SELECT
      extracto_idx,
      jsonb_build_object(
        'idx', extracto_idx,
        'fecha', extracto_fecha,
        'monto', extracto_monto,
        'descripcion', extracto_descripcion,
        'referencia_externa', extracto_referencia,
        'estado', CASE
          WHEN num_candidatos = 1 THEN 'verde'
          WHEN num_candidatos > 1 THEN 'amarillo'
          WHEN jsonb_array_length(combinaciones) = 1 THEN 'verde_agrupado'
          WHEN jsonb_array_length(combinaciones) > 1 THEN 'amarillo_agrupado'
          ELSE 'rojo_falta'
        END,
        'num_candidatos', num_candidatos,
        'candidatos', candidatos,
        'combinaciones', combinaciones
      ) AS row_json
    FROM _concil_tmp
  )
  SELECT jsonb_build_object(
    'extracto', COALESCE(
      (SELECT jsonb_agg(row_json ORDER BY extracto_idx) FROM filas_finales),
      '[]'::jsonb
    ),
    'sobrantes', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'fecha', fecha, 'importe', importe, 'detalle', detalle
      ) ORDER BY fecha DESC) FROM sobrantes),
      '[]'::jsonb
    ),
    'totales', jsonb_build_object(
      'extracto_total',     v_extracto_count,
      'verdes',             (SELECT COUNT(*) FROM filas_finales WHERE row_json->>'estado' = 'verde'),
      'amarillos',          (SELECT COUNT(*) FROM filas_finales WHERE row_json->>'estado' = 'amarillo'),
      'verdes_agrupados',   (SELECT COUNT(*) FROM filas_finales WHERE row_json->>'estado' = 'verde_agrupado'),
      'amarillos_agrupados',(SELECT COUNT(*) FROM filas_finales WHERE row_json->>'estado' = 'amarillo_agrupado'),
      'rojos_falta',        (SELECT COUNT(*) FROM filas_finales WHERE row_json->>'estado' = 'rojo_falta'),
      'rojos_sobra',        (SELECT COUNT(*) FROM sobrantes)
    )
  ) INTO v_resultado;

  -- Limpiar temp para que la próxima invocación dentro de la misma sesión funcione
  DROP TABLE IF EXISTS _concil_tmp;

  RETURN v_resultado;
END;
$$;

-- Limpiamos firmas viejas si existen.
DROP FUNCTION IF EXISTS fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB);
DROP FUNCTION IF EXISTS fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN);
REVOKE ALL ON FUNCTION fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN, BOOLEAN) TO authenticated;

COMMENT ON TABLE conciliacion_corridas IS
  'Histórico de conciliaciones de extracto MP por local + período. Una fila por archivo subido y cerrado (Lucas 10-jun).';

COMMENT ON FUNCTION fn_cruzar_extracto_mp IS
  'Cruza movs del extracto MP contra movimientos.cuenta=MercadoPago del local. Match: monto exacto + fecha ±15d. Retorna semáforo verde/amarillo/rojo_falta/rojo_sobra.';

NOTIFY pgrst, 'reload schema';
