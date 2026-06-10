-- 202606101200_conciliacion_v2_matching.sql
-- Reescritura del matching de fn_cruzar_extracto_mp tras el análisis con
-- data real de Rene Cantina (extracto mayo 2026, 100 egresos):
--   - Regla vieja (monto exacto): solo 28/100 matcheaban.
--   - +10 se perdían por CENTAVOS (Anto transfiere redondeado, carga la
--     factura con centavos: $440.999 vs $440.999,95).
--   - 2 combos fallaban porque el agrupado EXCLUÍA pagos de remito.
--   - Sin consumo 1-a-1: un mismo mov de PASE podía quedar verde en DOS
--     filas del extracto (duplicados tipo "Nieva -25.500 x2").
--   - Sueldos con monto redondo ($500.000) matcheaban transferencias ajenas
--     (retiro "Armando Baldi" ↔ sueldo TAPIA) — falso verde.
--   - Proveedores grandes (FRIGORIFICO MARILU): 6 transferencias vs 10
--     pagos cargados en tandas en fechas que NO se corresponden → imposible
--     aparear 1-a-1. Lo único útil es comparar TOTALES por proveedor.
--
-- Cambios v2:
--   R1 individual: tolerancia ±$1 + ventana ±15d + asignación greedy con
--      CONSUMO (un mov matchea una sola fila) + regla anti-falso-sueldo
--      (mov con liquidacion_id solo es candidato si el apellido del
--      empleado aparece en la descripción del extracto).
--   R2 sueldo por nombre: igual que antes (apellido ≥5 en desc + tolerancia
--      $500/0.5%) pero con consumo.
--   R3 combos 2..5 por proveedor: ahora INCLUYE remitos (prov vía
--      facturas.prov_id O remitos.prov_id), tolerancia ±$5, consumo.
--   R4 BLOQUES por proveedor (nuevo): para lo que queda rojo, agrupa por
--      proveedor usando tokens "raros" del nombre (≥5 chars, no genéricos)
--      buscados en la descripción del extracto. Compara la SUMA de
--      transferencias del extracto vs la SUMA de pagos libres en PASE:
--        · dif ≈ 0  → verde_bloque (todo conciliado en bloque)
--        · dif ≠ 0  → bloque_diferencia: "transferiste $X / cargaste $Y →
--          faltan cargar $Z" — la info accionable para Anto.
--
-- Estados resultantes: verde | amarillo | verde_agrupado | amarillo_agrupado
--                      | verde_bloque | bloque_diferencia | rojo_falta

DROP FUNCTION IF EXISTS fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB);
DROP FUNCTION IF EXISTS fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION fn_cruzar_extracto_mp(
  p_local_id      INTEGER,
  p_periodo_desde DATE,
  p_periodo_hasta DATE,
  p_movs_extracto JSONB,
  p_solo_egresos  BOOLEAN DEFAULT TRUE,
  p_match_agrupado BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_resultado JSONB;
  v_ext_count INTEGER;
  v_vent_ind_desde DATE; v_vent_ind_hasta DATE;     -- ±15d (individual)
  v_vent_agr_desde DATE; v_vent_agr_hasta DATE;     -- ±30d (agrupado/bloque)
  -- loop vars
  v_fila RECORD;
  v_mov  RECORD;
  v_prov RECORD;
  v_cand_count INT;
  v_cand_id TEXT;
  v_cands JSONB;
  v_iter INT;
  v_cambio BOOLEAN;
  -- combos
  v_movs_arr JSONB[];
  v_amounts NUMERIC[];
  v_ids TEXT[];
  v_n INT;
  i1 INT; i2 INT; i3 INT; i4 INT; i5 INT;
  v_suma NUMERIC;
  v_combos JSONB;
  v_combo_movs JSONB;
  v_combo_ids TEXT[];
  -- bloques
  v_tokens TEXT[];
  v_tok TEXT;
  v_regex TEXT;
  v_filas_bloque INT[];
  v_suma_ext NUMERIC;
  v_suma_pase NUMERIC;
  v_movs_bloque JSONB;
  v_ids_bloque TEXT[];
  v_dif NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin()
     AND NOT (p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO';
  END IF;

  v_vent_ind_desde := p_periodo_desde - INTERVAL '15 days';
  v_vent_ind_hasta := p_periodo_hasta + INTERVAL '15 days';
  v_vent_agr_desde := p_periodo_desde - INTERVAL '30 days';
  v_vent_agr_hasta := p_periodo_hasta + INTERVAL '30 days';

  DROP TABLE IF EXISTS _ce_ext;
  DROP TABLE IF EXISTS _ce_mov;

  -- ── Filas del extracto (egresos) ────────────────────────────────────────
  CREATE TEMP TABLE _ce_ext AS
  SELECT
    (ordinality - 1)::INT                  AS idx,
    (e->>'fecha')::DATE                    AS fecha,
    (e->>'monto')::NUMERIC                 AS monto,
    COALESCE(e->>'descripcion', '')        AS descripcion,
    NULLIF(e->>'referencia_externa', '')   AS referencia,
    'rojo_falta'::TEXT                     AS estado,
    '[]'::JSONB                            AS candidatos,
    '[]'::JSONB                            AS combinaciones,
    NULL::JSONB                            AS bloque,
    '[]'::JSONB                            AS facturas_pend,
    NULL::TEXT                             AS alias_tipo,
    NULL::INTEGER                          AS alias_prov
  FROM jsonb_array_elements(p_movs_extracto) WITH ORDINALITY AS t(e, ordinality)
  WHERE (NOT p_solo_egresos OR (e->>'monto')::NUMERIC < 0);

  SELECT COUNT(*) INTO v_ext_count FROM _ce_ext;

  -- ── ALIAS APRENDIDOS (Lucas 10-jun: solución general) ──────────────────
  -- Mapeo titular→proveedor/gasto_directo aprendido de conciliaciones
  -- anteriores. El alias GOBIERNA combos, facturas pendientes y bloques.
  UPDATE _ce_ext e SET
    alias_tipo = a.tipo,
    alias_prov = a.prov_id
  FROM conciliacion_alias a
  WHERE a.tenant_id = v_tenant_id
    AND a.local_id = p_local_id
    AND a.titular = fn_extraer_titular(e.descripcion);

  -- ── PASS 0: filas YA CONCILIADAS en cierres anteriores ─────────────────
  -- (Lucas 10-jun: el "tag invisible"). Si la transferencia ya quedó
  -- registrada en una corrida cerrada (match por referencia MP, o por
  -- fecha+monto+descripción), no se vuelve a procesar. Esto permite
  -- re-subir el mismo archivo sin que todo aparezca rojo, y elimina la
  -- dependencia de ventanas de tiempo entre meses.
  -- Las filas que quedaron SIN resolver en el cierre anterior (rojas,
  -- amarillas, bloques con diferencia) SÍ se vuelven a ofrecer.
  UPDATE _ce_ext e SET estado = 'ya_conciliada'
  WHERE EXISTS (
    SELECT 1
    FROM conciliacion_extracto_items i
    JOIN conciliacion_corridas c ON c.id = i.corrida_id
    WHERE i.tenant_id = v_tenant_id
      AND i.local_id = p_local_id
      AND c.cuenta = 'MercadoPago'
      AND c.cerrada_at IS NOT NULL
      AND i.estado_final NOT IN ('rojo_falta','amarillo','amarillo_agrupado','bloque_diferencia')
      AND (
        (e.referencia IS NOT NULL AND i.referencia_externa IS NOT NULL
         AND i.referencia_externa = e.referencia)
        OR (i.fecha = e.fecha AND i.monto = e.monto
            AND COALESCE(i.descripcion, '') = e.descripcion)
      )
  );

  -- ── Movs de PASE (egresos MP del local, ventana amplia ±30d) ───────────
  -- prov viene de factura O remito. emp_apellido si es pago de sueldo.
  CREATE TEMP TABLE _ce_mov AS
  SELECT
    m.id, m.fecha, m.importe, m.detalle,
    COALESCE(f.prov_id, r.prov_id)         AS prov_id,
    COALESCE(pf.nombre, pr.nombre)         AS prov_nombre,
    e.apellido                             AS emp_apellido,
    (m.liquidacion_id IS NOT NULL)         AS es_sueldo,
    FALSE                                  AS usado,
    NULL::TEXT                             AS bloque_prov
  FROM movimientos m
  LEFT JOIN facturas f  ON f.id = m.fact_id
  LEFT JOIN proveedores pf ON pf.id = f.prov_id
  LEFT JOIN remitos r   ON r.id = m.remito_id_ref
  LEFT JOIN proveedores pr ON pr.id = r.prov_id
  LEFT JOIN rrhh_liquidaciones l ON l.id = m.liquidacion_id
  LEFT JOIN rrhh_novedades nv ON nv.id = l.novedad_id
  LEFT JOIN rrhh_empleados e ON e.id = nv.empleado_id
  WHERE m.tenant_id = v_tenant_id
    AND m.local_id = p_local_id
    AND m.cuenta = 'MercadoPago'
    AND m.anulado = false
    -- Tag invisible (Lucas 10-jun): lo ya conciliado en corridas
    -- anteriores no entra nunca más (ni candidato ni sobrante).
    AND m.conciliado_corrida_id IS NULL
    AND m.fecha BETWEEN v_vent_agr_desde AND v_vent_agr_hasta
    AND (NOT p_solo_egresos OR m.importe < 0);

  -- ── R1: individual ±$1, ±15d, consumo greedy (3 iteraciones) ───────────
  -- Anti-falso-sueldo: un mov de sueldo SOLO es candidato si el apellido
  -- del empleado aparece como palabra en la descripción del extracto.
  FOR v_iter IN 1..3 LOOP
    v_cambio := FALSE;
    FOR v_fila IN SELECT * FROM _ce_ext WHERE estado = 'rojo_falta' ORDER BY idx LOOP
      SELECT COUNT(*), MIN(m.id)
      INTO v_cand_count, v_cand_id
      FROM _ce_mov m
      WHERE NOT m.usado
        AND ABS(m.importe - v_fila.monto) <= 1
        AND ABS(m.fecha - v_fila.fecha) <= 15
        AND (
          m.emp_apellido IS NULL
          OR unaccent(LOWER(v_fila.descripcion)) ~* ('\m' || unaccent(LOWER(m.emp_apellido)) || '\M')
        );
      IF v_cand_count = 1 THEN
        UPDATE _ce_mov SET usado = TRUE WHERE id = v_cand_id;
        UPDATE _ce_ext SET
          estado = 'verde',
          candidatos = (
            SELECT jsonb_build_array(jsonb_build_object(
              'id', m.id, 'fecha', m.fecha, 'importe', m.importe,
              'detalle', m.detalle,
              'dias_diff', ABS(m.fecha - v_fila.fecha),
              'dif_monto', ABS(m.importe - v_fila.monto),
              'ya_conciliado', false
            )) FROM _ce_mov m WHERE m.id = v_cand_id
          )
        WHERE idx = v_fila.idx;
        v_cambio := TRUE;
      END IF;
    END LOOP;
    EXIT WHEN NOT v_cambio;
  END LOOP;

  -- Filas con MÚLTIPLES candidatos libres → amarillo (no consume, elige el user)
  FOR v_fila IN SELECT * FROM _ce_ext WHERE estado = 'rojo_falta' ORDER BY idx LOOP
    SELECT COUNT(*),
           COALESCE(jsonb_agg(jsonb_build_object(
             'id', m.id, 'fecha', m.fecha, 'importe', m.importe,
             'detalle', m.detalle,
             'dias_diff', ABS(m.fecha - v_fila.fecha),
             'dif_monto', ABS(m.importe - v_fila.monto),
             'ya_conciliado', false
           ) ORDER BY ABS(m.fecha - v_fila.fecha)), '[]'::jsonb)
    INTO v_cand_count, v_cands
    FROM _ce_mov m
    WHERE NOT m.usado
      AND ABS(m.importe - v_fila.monto) <= 1
      AND ABS(m.fecha - v_fila.fecha) <= 15
      AND (
        m.emp_apellido IS NULL
        OR unaccent(LOWER(v_fila.descripcion)) ~* ('\m' || unaccent(LOWER(m.emp_apellido)) || '\M')
      );
    IF v_cand_count >= 2 THEN
      UPDATE _ce_ext SET estado = 'amarillo', candidatos = v_cands WHERE idx = v_fila.idx;
    END IF;
  END LOOP;

  -- ── R2: sueldos por nombre (tolerancia amplia $500/0.5%) ───────────────
  FOR v_fila IN SELECT * FROM _ce_ext WHERE estado = 'rojo_falta' ORDER BY idx LOOP
    SELECT COUNT(*), MIN(m.id),
           COALESCE(jsonb_agg(jsonb_build_object(
             'id', m.id, 'fecha', m.fecha, 'importe', m.importe,
             'detalle', m.detalle || ' [' || m.emp_apellido || ']',
             'dias_diff', ABS(m.fecha - v_fila.fecha),
             'dif_monto', ABS(m.importe - v_fila.monto),
             'ya_conciliado', false, 'match_por_nombre', true
           ) ORDER BY ABS(m.importe - v_fila.monto)), '[]'::jsonb)
    INTO v_cand_count, v_cand_id, v_cands
    FROM _ce_mov m
    WHERE NOT m.usado
      AND m.es_sueldo
      AND m.emp_apellido IS NOT NULL
      AND LENGTH(m.emp_apellido) >= 5
      AND unaccent(LOWER(v_fila.descripcion)) ~* ('\m' || unaccent(LOWER(m.emp_apellido)) || '\M')
      AND ABS(m.fecha - v_fila.fecha) <= 15
      AND (
        ABS(m.importe - v_fila.monto) <= 500
        OR ABS(m.importe - v_fila.monto) <= ABS(v_fila.monto) * 0.005
      );
    IF v_cand_count = 1 THEN
      UPDATE _ce_mov SET usado = TRUE WHERE id = v_cand_id;
      UPDATE _ce_ext SET estado = 'verde', candidatos = v_cands WHERE idx = v_fila.idx;
    ELSIF v_cand_count >= 2 THEN
      UPDATE _ce_ext SET estado = 'amarillo', candidatos = v_cands WHERE idx = v_fila.idx;
    END IF;
  END LOOP;

  -- ── R3: combos 2..5 por proveedor, ±$5, INCLUYE remitos, consumo ───────
  -- Insight operativo (Lucas 10-jun): cuando Anto paga N facturas con UNA
  -- transferencia, las marca como pagadas TODAS JUNTAS, el mismo día o muy
  -- cerca del día de la transferencia real. Por eso los candidatos del
  -- combo se filtran a ±4 días de la fecha de la transferencia — acota el
  -- espacio de búsqueda y elimina combos espurios de fechas lejanas.
  IF p_match_agrupado THEN
    FOR v_fila IN SELECT * FROM _ce_ext WHERE estado = 'rojo_falta' ORDER BY idx LOOP
      -- Alias gasto_directo: este titular no es proveedor — sin combos.
      IF v_fila.alias_tipo = 'gasto_directo' THEN CONTINUE; END IF;
      v_combos := '[]'::jsonb;
      v_combo_ids := NULL;

      FOR v_prov IN
        SELECT m.prov_id, m.prov_nombre, COUNT(*) AS n
        FROM _ce_mov m
        WHERE NOT m.usado AND m.prov_id IS NOT NULL
          AND ABS(m.fecha - v_fila.fecha) <= 4
          -- Alias proveedor: solo combos con ESE proveedor.
          AND (v_fila.alias_prov IS NULL OR m.prov_id = v_fila.alias_prov)
        GROUP BY m.prov_id, m.prov_nombre
        HAVING COUNT(*) >= 2
      LOOP
        SELECT
          array_agg(jsonb_build_object('id', m.id, 'fecha', m.fecha, 'importe', m.importe, 'detalle', m.detalle) ORDER BY m.fecha),
          array_agg(m.importe ORDER BY m.fecha),
          array_agg(m.id ORDER BY m.fecha)
        INTO v_movs_arr, v_amounts, v_ids
        FROM (
          SELECT * FROM _ce_mov m2
          WHERE NOT m2.usado AND m2.prov_id = v_prov.prov_id
            AND ABS(m2.fecha - v_fila.fecha) <= 4
          ORDER BY m2.fecha LIMIT 12
        ) m;
        v_n := COALESCE(array_length(v_movs_arr, 1), 0);
        IF v_n < 2 THEN CONTINUE; END IF;

        -- PASO PREVIO "tanda completa": si TODOS los pagos del proveedor
        -- en ±4d suman el monto de la transferencia → combo único directo,
        -- sin límite de 5 facturas (cubre tandas de 6, 7, 10 facturas).
        v_suma := 0;
        FOR i1 IN 1..v_n LOOP v_suma := v_suma + v_amounts[i1]; END LOOP;
        IF ABS(v_suma - v_fila.monto) <= GREATEST(10, 2 * v_n) THEN
          v_combos := v_combos || jsonb_build_object(
            'proveedor', v_prov.prov_nombre, 'num_movs', v_n,
            'movs', (SELECT jsonb_agg(x) FROM unnest(v_movs_arr) AS x));
          IF v_combo_ids IS NULL THEN v_combo_ids := v_ids; END IF;
          CONTINUE; -- tanda completa encontrada, no hace falta subset-sum
        END IF;

        FOR i1 IN 1..v_n LOOP FOR i2 IN (i1+1)..v_n LOOP
          v_suma := v_amounts[i1] + v_amounts[i2];
          IF ABS(v_suma - v_fila.monto) <= 10 THEN
            v_combos := v_combos || jsonb_build_object('proveedor', v_prov.prov_nombre, 'num_movs', 2,
              'movs', jsonb_build_array(v_movs_arr[i1], v_movs_arr[i2]));
            IF v_combo_ids IS NULL THEN v_combo_ids := ARRAY[v_ids[i1], v_ids[i2]]; END IF;
          END IF;
          IF v_n >= 3 THEN FOR i3 IN (i2+1)..v_n LOOP
            v_suma := v_amounts[i1] + v_amounts[i2] + v_amounts[i3];
            IF ABS(v_suma - v_fila.monto) <= 10 THEN
              v_combos := v_combos || jsonb_build_object('proveedor', v_prov.prov_nombre, 'num_movs', 3,
                'movs', jsonb_build_array(v_movs_arr[i1], v_movs_arr[i2], v_movs_arr[i3]));
              IF v_combo_ids IS NULL THEN v_combo_ids := ARRAY[v_ids[i1], v_ids[i2], v_ids[i3]]; END IF;
            END IF;
            IF v_n >= 4 THEN FOR i4 IN (i3+1)..v_n LOOP
              v_suma := v_amounts[i1] + v_amounts[i2] + v_amounts[i3] + v_amounts[i4];
              IF ABS(v_suma - v_fila.monto) <= 10 THEN
                v_combos := v_combos || jsonb_build_object('proveedor', v_prov.prov_nombre, 'num_movs', 4,
                  'movs', jsonb_build_array(v_movs_arr[i1], v_movs_arr[i2], v_movs_arr[i3], v_movs_arr[i4]));
                IF v_combo_ids IS NULL THEN v_combo_ids := ARRAY[v_ids[i1], v_ids[i2], v_ids[i3], v_ids[i4]]; END IF;
              END IF;
              IF v_n >= 5 THEN FOR i5 IN (i4+1)..v_n LOOP
                v_suma := v_amounts[i1] + v_amounts[i2] + v_amounts[i3] + v_amounts[i4] + v_amounts[i5];
                IF ABS(v_suma - v_fila.monto) <= 10 THEN
                  v_combos := v_combos || jsonb_build_object('proveedor', v_prov.prov_nombre, 'num_movs', 5,
                    'movs', jsonb_build_array(v_movs_arr[i1], v_movs_arr[i2], v_movs_arr[i3], v_movs_arr[i4], v_movs_arr[i5]));
                  IF v_combo_ids IS NULL THEN v_combo_ids := ARRAY[v_ids[i1], v_ids[i2], v_ids[i3], v_ids[i4], v_ids[i5]]; END IF;
                END IF;
              END LOOP; END IF;
            END LOOP; END IF;
          END LOOP; END IF;
        END LOOP; END LOOP;
      END LOOP;

      IF jsonb_array_length(v_combos) = 1 THEN
        -- combinación única → verde agrupado, consume
        UPDATE _ce_mov SET usado = TRUE WHERE id = ANY(v_combo_ids);
        UPDATE _ce_ext SET estado = 'verde_agrupado', combinaciones = v_combos WHERE idx = v_fila.idx;
      ELSIF jsonb_array_length(v_combos) > 1 THEN
        UPDATE _ce_ext SET estado = 'amarillo_agrupado', combinaciones = v_combos WHERE idx = v_fila.idx;
      END IF;
    END LOOP;
  END IF;

  -- ── R3.5: facturas/remitos CARGADOS pero NO marcados como pagados ──────
  -- (Lucas 10-jun: "a veces los empleados se olvidan de marcar como pagado
  -- las facturas"). La transferencia salió, la factura existe en PASE,
  -- pero nadie tocó Pagar → no hay movimiento → el matcher no la ve.
  -- Buscamos facturas estado='pendiente' (y remitos 'sin_factura') cuyo
  -- total coincida con la transferencia (±$1), emitidas hasta 60 días antes
  -- (se compra a crédito). Si no hay match individual, probamos la TANDA:
  -- la suma de todas las pendientes del proveedor ≈ la transferencia.
  FOR v_fila IN SELECT * FROM _ce_ext WHERE estado = 'rojo_falta' ORDER BY idx LOOP
    -- Alias gasto_directo: titular que no es proveedor — sin facturas.
    IF v_fila.alias_tipo = 'gasto_directo' THEN CONTINUE; END IF;
    -- a) individual: 1 factura/remito pendiente con total ≈ |monto|
    SELECT COUNT(*), COALESCE(jsonb_agg(jsonb_build_object(
      'tipo', t.tipo, 'id', t.id, 'nro', t.nro, 'proveedor', t.prov_nombre,
      'fecha', t.fecha, 'total', t.total,
      'dif', ABS(t.total - ABS(v_fila.monto))
    ) ORDER BY ABS(t.total - ABS(v_fila.monto))), '[]'::jsonb)
    INTO v_cand_count, v_cands
    FROM (
      SELECT 'factura'::TEXT AS tipo, f.id, f.nro, p.nombre AS prov_nombre, f.fecha, f.total
      FROM facturas f LEFT JOIN proveedores p ON p.id = f.prov_id
      WHERE f.tenant_id = v_tenant_id AND f.local_id = p_local_id
        AND f.estado = 'pendiente' AND f.total > 0
        AND ABS(f.total - ABS(v_fila.monto)) <= 1
        AND f.fecha BETWEEN v_fila.fecha - 180 AND v_fila.fecha + 5
        AND (v_fila.alias_prov IS NULL OR f.prov_id = v_fila.alias_prov)
      UNION ALL
      SELECT 'remito', r.id, r.nro, p.nombre, r.fecha, r.monto
      FROM remitos r LEFT JOIN proveedores p ON p.id = r.prov_id
      WHERE r.tenant_id = v_tenant_id AND r.local_id = p_local_id
        AND r.estado = 'sin_factura' AND r.monto > 0
        AND ABS(r.monto - ABS(v_fila.monto)) <= 1
        AND r.fecha BETWEEN v_fila.fecha - 180 AND v_fila.fecha + 5
        AND (v_fila.alias_prov IS NULL OR r.prov_id = v_fila.alias_prov)
    ) t;
    IF v_cand_count >= 1 THEN
      UPDATE _ce_ext SET estado = 'factura_sin_pagar', facturas_pend = v_cands
      WHERE idx = v_fila.idx;
      CONTINUE;
    END IF;

    -- b) tanda: 2+ facturas pendientes del mismo proveedor que SUMAN ≈ |monto|
    SELECT COALESCE(jsonb_agg(g.bloque), '[]'::jsonb)
    INTO v_cands
    FROM (
      SELECT jsonb_build_object(
        'tipo', 'tanda', 'proveedor', p.nombre,
        'n', COUNT(*), 'total_suma', SUM(f.total),
        'dif', ABS(SUM(f.total) - ABS(v_fila.monto)),
        'facturas', jsonb_agg(jsonb_build_object(
          'tipo', 'factura', 'id', f.id, 'nro', f.nro, 'fecha', f.fecha, 'total', f.total
        ) ORDER BY f.fecha)
      ) AS bloque
      FROM facturas f LEFT JOIN proveedores p ON p.id = f.prov_id
      WHERE f.tenant_id = v_tenant_id AND f.local_id = p_local_id
        AND f.estado = 'pendiente' AND f.total > 0
        AND f.fecha BETWEEN v_fila.fecha - 180 AND v_fila.fecha + 5
      GROUP BY f.prov_id, p.nombre
      HAVING COUNT(*) >= 2
         AND ABS(SUM(f.total) - ABS(v_fila.monto)) <= GREATEST(2, COUNT(*))
    ) g;
    IF jsonb_array_length(v_cands) >= 1 THEN
      UPDATE _ce_ext SET estado = 'factura_sin_pagar', facturas_pend = v_cands
      WHERE idx = v_fila.idx;
    END IF;
  END LOOP;

  -- ── R4: BLOQUES por proveedor (suma extracto vs suma PASE) ─────────────
  -- Para cada proveedor con movs libres: tokens "raros" del nombre (≥5
  -- chars, no genéricos) buscados en la descripción de las filas rojas.
  -- Compara totales y reporta la diferencia.
  IF p_match_agrupado THEN
    FOR v_prov IN
      SELECT m.prov_id, m.prov_nombre, COUNT(*) AS n_movs, SUM(m.importe) AS suma_movs
      FROM _ce_mov m
      WHERE NOT m.usado AND m.prov_id IS NOT NULL
      GROUP BY m.prov_id, m.prov_nombre
    LOOP
      -- tokens raros del nombre del proveedor
      SELECT array_agg(DISTINCT tok)
      INTO v_tokens
      FROM unnest(regexp_split_to_array(unaccent(UPPER(COALESCE(v_prov.prov_nombre, ''))), '[^A-Z]+')) AS tok
      WHERE LENGTH(tok) >= 5
        AND tok NOT IN ('DISTRIBUIDORA','FRIGORIFICO','ALIMENTOS','CONSULTORA','SOCIEDAD','ANONIMA',
                        'COMERCIAL','SERVICIOS','PRODUCTOS','HERMANOS','ARGENTINA','BEBIDAS',
                        'IMPORTADORA','EXPORTADORA','MAYORISTA','MINORISTA');
      IF v_tokens IS NULL OR array_length(v_tokens, 1) = 0 THEN CONTINUE; END IF;

      v_regex := '\m(' || array_to_string(v_tokens, '|') || ')\M';

      -- filas del extracto aún rojas que pertenecen a este proveedor:
      -- con ALIAS aprendido manda el alias (exacto); sin alias, heurística
      -- de tokens — pero NUNCA si la fila tiene alias a OTRO proveedor o
      -- a gasto_directo (caso Baldi: retiros de la dueña compartían
      -- apellido con el proveedor ARMANDO MARIO BALDI).
      SELECT array_agg(idx), SUM(monto), COUNT(*)
      INTO v_filas_bloque, v_suma_ext, v_cand_count
      FROM _ce_ext
      WHERE estado = 'rojo_falta'
        AND (
          alias_prov = v_prov.prov_id
          OR (alias_prov IS NULL
              AND COALESCE(alias_tipo, '') <> 'gasto_directo'
              AND unaccent(UPPER(descripcion)) ~ v_regex)
        );

      IF v_filas_bloque IS NULL OR v_cand_count = 0 THEN CONTINUE; END IF;

      -- movs libres del proveedor — SOLO del período + 4 días de margen.
      -- Fix Lucas 10-jun: un pago del 9/6 entraba al bloque de MAYO
      -- (ventana vieja ±30d) y distorsionaba la suma ("hay $X cargados
      -- de más"). Ese pago corresponde a una transferencia de JUNIO que
      -- va a aparecer en el extracto de junio. Por la regla de tanda
      -- (los pagos se cargan cerca de la transferencia real), los pagos
      -- del bloque del mes son: período ± 4 días.
      SELECT SUM(m.importe),
             jsonb_agg(jsonb_build_object('id', m.id, 'fecha', m.fecha, 'importe', m.importe, 'detalle', m.detalle) ORDER BY m.fecha),
             array_agg(m.id),
             COUNT(*)
      INTO v_suma_pase, v_movs_bloque, v_ids_bloque, v_n
      FROM _ce_mov m
      WHERE NOT m.usado AND m.prov_id = v_prov.prov_id
        AND m.fecha BETWEEN p_periodo_desde - 4 AND p_periodo_hasta + 4;

      -- Si el proveedor no tiene NINGÚN pago dentro del período±4d, el
      -- bloque no aporta nada (las filas quedan rojas → "no cargado").
      IF COALESCE(v_n, 0) = 0 THEN CONTINUE; END IF;

      v_dif := v_suma_ext - COALESCE(v_suma_pase, 0);

      IF ABS(v_dif) <= GREATEST(2, (v_cand_count + COALESCE(v_n, 0))) THEN
        -- Suma cierra → todo el bloque verde, consume
        UPDATE _ce_mov SET usado = TRUE WHERE id = ANY(v_ids_bloque);
        UPDATE _ce_ext SET
          estado = 'verde_bloque',
          bloque = jsonb_build_object(
            'proveedor', v_prov.prov_nombre,
            'n_transferencias', v_cand_count,
            'suma_extracto', v_suma_ext,
            'n_pagos', v_n,
            'suma_pase', v_suma_pase,
            'dif', v_dif,
            'movs', v_movs_bloque
          )
        WHERE idx = ANY(v_filas_bloque);
      ELSE
        -- Suma NO cierra → informar la diferencia (accionable: "faltan
        -- cargar $X en pagos a este proveedor")
        UPDATE _ce_mov SET bloque_prov = v_prov.prov_nombre WHERE id = ANY(v_ids_bloque);
        UPDATE _ce_ext SET
          estado = 'bloque_diferencia',
          bloque = jsonb_build_object(
            'proveedor', v_prov.prov_nombre,
            'n_transferencias', v_cand_count,
            'suma_extracto', v_suma_ext,
            'n_pagos', v_n,
            'suma_pase', v_suma_pase,
            'dif', v_dif,
            'movs', v_movs_bloque,
            -- Pista clave (Lucas 10-jun caso EL CRIOLLO $555.950 vencida):
            -- las facturas/remitos PENDIENTES del proveedor. Parte de la
            -- diferencia suele ser una factura cargada que nadie marcó
            -- como pagada — mostrarla acá conecta los puntos.
            'facturas_pendientes', (
              SELECT COALESCE(jsonb_agg(t.j ORDER BY (t.j->>'fecha')), '[]'::jsonb)
              FROM (
                SELECT jsonb_build_object(
                  'tipo', 'factura', 'id', f.id, 'nro', f.nro,
                  'fecha', f.fecha, 'total', f.total
                ) AS j
                FROM facturas f
                WHERE f.tenant_id = v_tenant_id AND f.local_id = p_local_id
                  AND f.prov_id = v_prov.prov_id
                  AND f.estado = 'pendiente' AND f.total > 0
                  AND f.fecha <= p_periodo_hasta + 5
                UNION ALL
                SELECT jsonb_build_object(
                  'tipo', 'remito', 'id', r.id, 'nro', r.nro,
                  'fecha', r.fecha, 'total', r.monto
                )
                FROM remitos r
                WHERE r.tenant_id = v_tenant_id AND r.local_id = p_local_id
                  AND r.prov_id = v_prov.prov_id
                  AND r.estado = 'sin_factura' AND r.monto > 0
                  AND r.fecha <= p_periodo_hasta + 5
              ) t
            )
          )
        WHERE idx = ANY(v_filas_bloque);
      END IF;
    END LOOP;
  END IF;

  -- ── Resultado ────────────────────────────────────────────────────────────
  SELECT jsonb_build_object(
    'extracto', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'idx', idx, 'fecha', fecha, 'monto', monto,
        'descripcion', descripcion, 'referencia_externa', referencia,
        'estado', estado,
        'num_candidatos', jsonb_array_length(candidatos),
        'candidatos', candidatos,
        'combinaciones', combinaciones,
        'bloque', bloque,
        'facturas_pendientes', facturas_pend
      ) ORDER BY idx) FROM _ce_ext
    ), '[]'::jsonb),
    'sobrantes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'fecha', m.fecha, 'importe', m.importe, 'detalle', m.detalle,
        'bloque_prov', m.bloque_prov
      ) ORDER BY m.fecha DESC)
      FROM _ce_mov m
      WHERE NOT m.usado
        AND m.fecha BETWEEN p_periodo_desde AND p_periodo_hasta
    ), '[]'::jsonb),
    'totales', jsonb_build_object(
      'extracto_total',      v_ext_count,
      'verdes',              (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'verde'),
      'amarillos',           (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'amarillo'),
      'verdes_agrupados',    (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'verde_agrupado'),
      'amarillos_agrupados', (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'amarillo_agrupado'),
      'verdes_bloque',       (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'verde_bloque'),
      'bloques_diferencia',  (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'bloque_diferencia'),
      'facturas_sin_pagar',  (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'factura_sin_pagar'),
      'ya_conciliadas',      (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'ya_conciliada'),
      'rojos_falta',         (SELECT COUNT(*) FROM _ce_ext WHERE estado = 'rojo_falta'),
      'rojos_sobra',         (SELECT COUNT(*) FROM _ce_mov m WHERE NOT m.usado
                               AND m.fecha BETWEEN p_periodo_desde AND p_periodo_hasta)
    )
  ) INTO v_resultado;

  DROP TABLE IF EXISTS _ce_ext;
  DROP TABLE IF EXISTS _ce_mov;

  RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cruzar_extracto_mp(INTEGER, DATE, DATE, JSONB, BOOLEAN, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION fn_cruzar_extracto_mp IS
  'v2 (10-jun): matching extracto MP vs movimientos. R1 individual ±$1 ±15d con consumo + anti-falso-sueldo; R2 sueldo por apellido; R3 combos 2-5 por prov (facturas+remitos) ±$5; R4 bloques por proveedor con diferencia de totales.';

NOTIFY pgrst, 'reload schema';
