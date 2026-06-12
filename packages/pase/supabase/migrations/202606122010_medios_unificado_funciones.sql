-- ============================================================
-- 202606122010_medios_unificado_funciones.sql
-- Tier 1 #3 (parte B): funciones que tocan medios de cobro.
--
-- 1) fn_proyectar_venta_pos v2 (base: 202606121200): el POS
--    guarda SLUG ("efectivo") en ventas_pos_pagos.metodo, pero el
--    EERR agrupa por NOMBRE ("EFECTIVO"). Antes del upsert se
--    traduce slug→nombre contra el catálogo del tenant; el detalle
--    JSONB de la proyección guarda el nombre YA traducido para que
--    el reverso descuente contra la fila correcta. Si el metodo no
--    existe en el catálogo, fallback al texto crudo (no rompe).
--
-- 2) crear_cierre_ventas v2 (base: 202605121630 + hotfix live
--    202605271300): con catálogos por-tenant, el lookup de
--    cuenta_destino por nombre sin tenant podía cruzar catálogos.
--    Se agrega tenant_id = v_tenant_id + deleted_at IS NULL.
--    OJO: la versión live tiene ON CONFLICT (rpc_name, key,
--    tenant_id) (hotfix programático 27-may) — esta copia lo
--    preserva (el archivo 202605121630 tiene la versión vieja de
--    2 columnas; copiarla literal regresionaría el hotfix).
-- ============================================================

BEGIN;

-- 1) fn_proyectar_venta_pos v2 ------------------------------------------------
CREATE OR REPLACE FUNCTION fn_proyectar_venta_pos(p_venta_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_fecha DATE;
  v_turno TEXT;
  v_pago RECORD;
  v_detalle JSONB := '[]'::jsonb;
  v_filas INTEGER := 0;
  v_medio_nombre TEXT;
  v_medio_final TEXT;
BEGIN
  SELECT id, tenant_id, local_id, cobrada_at
    INTO v_venta
    FROM ventas_pos
   WHERE id = p_venta_id
     AND estado = 'cobrada'
     AND deleted_at IS NULL;
  IF v_venta.id IS NULL THEN
    RETURN 0; -- no cobrada / no existe: nada que proyectar
  END IF;

  -- Idempotencia: si esta venta ya proyectó, no volver a sumar.
  IF EXISTS (SELECT 1 FROM ventas_pos_proyecciones WHERE venta_id = p_venta_id) THEN
    RETURN 0;
  END IF;

  -- Día y turno operativos en hora Argentina.
  v_fecha := (COALESCE(v_venta.cobrada_at, NOW()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_turno := CASE
    WHEN ((COALESCE(v_venta.cobrada_at, NOW()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::TIME < TIME '17:00')
    THEN 'Mediodía' ELSE 'Noche' END;

  FOR v_pago IN
    SELECT p.metodo,
           SUM(p.monto - COALESCE(p.propina_incluida, 0)) AS neto
      FROM ventas_pos_pagos p
     WHERE p.venta_id = p_venta_id
       AND p.estado = 'confirmado'
       AND p.deleted_at IS NULL
     GROUP BY p.metodo
    HAVING SUM(p.monto - COALESCE(p.propina_incluida, 0)) <> 0
  LOOP
    -- Traducción slug→nombre contra el catálogo unificado del tenant.
    -- El POS guarda slug ("efectivo"); el EERR agrupa por nombre ("EFECTIVO").
    v_medio_nombre := NULL;
    SELECT mc.nombre INTO v_medio_nombre
      FROM medios_cobro mc
     WHERE mc.tenant_id = v_venta.tenant_id
       AND (mc.local_id IS NULL OR mc.local_id = v_venta.local_id)
       AND mc.deleted_at IS NULL
       AND (mc.slug = v_pago.metodo OR upper(mc.nombre) = upper(v_pago.metodo))
     ORDER BY mc.local_id NULLS LAST
     LIMIT 1;
    v_medio_final := COALESCE(v_medio_nombre, v_pago.metodo);

    INSERT INTO ventas (id, tenant_id, local_id, fecha, turno, medio, monto, origen)
    VALUES (
      'VC' || replace(gen_random_uuid()::text, '-', ''),
      v_venta.tenant_id, v_venta.local_id, v_fecha, v_turno, v_medio_final, v_pago.neto, 'comanda'
    )
    ON CONFLICT (tenant_id, local_id, fecha, turno, medio) WHERE origen = 'comanda'
    DO UPDATE SET monto = ventas.monto + EXCLUDED.monto;

    v_detalle := v_detalle || jsonb_build_object('medio', v_medio_final, 'monto', v_pago.neto);
    v_filas := v_filas + 1;
  END LOOP;

  IF v_filas > 0 THEN
    INSERT INTO ventas_pos_proyecciones (venta_id, tenant_id, local_id, fecha, turno, detalle)
    VALUES (p_venta_id, v_venta.tenant_id, v_venta.local_id, v_fecha, v_turno, v_detalle);
  END IF;

  RETURN v_filas;
END;
$$;
REVOKE ALL ON FUNCTION fn_proyectar_venta_pos(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_proyectar_venta_pos(BIGINT) TO authenticated, service_role;

-- 2) crear_cierre_ventas v2 ---------------------------------------------------
CREATE OR REPLACE FUNCTION crear_cierre_ventas(
  p_local_id INTEGER,
  p_fecha DATE,
  p_turno TEXT,
  p_lineas JSONB,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_linea jsonb;
  v_medio text;
  v_monto numeric;
  v_cuenta text;
  v_venta_id text;
  v_venta_ids text[] := ARRAY[]::text[];
  v_mov_ids text[] := ARRAY[]::text[];
  v_total numeric := 0;
  v_impacto jsonb := '{}'::jsonb;
  v_ids_por_cuenta jsonb := '{}'::jsonb;
  v_cached jsonb;
  v_result jsonb;
  v_cuenta_iter text;
  v_monto_iter numeric;
  v_mov_id text;
  v_idx int := 0;
BEGIN
  -- ─── Validaciones de input ─────────────────────────────────────────────
  IF p_local_id IS NULL THEN RAISE EXCEPTION 'LOCAL_REQUIRED'; END IF;
  IF p_fecha IS NULL THEN RAISE EXCEPTION 'FECHA_REQUIRED'; END IF;
  IF p_turno IS NULL OR trim(p_turno) = '' THEN RAISE EXCEPTION 'TURNO_REQUIRED'; END IF;
  IF p_lineas IS NULL OR jsonb_typeof(p_lineas) != 'array' OR jsonb_array_length(p_lineas) = 0 THEN
    RAISE EXCEPTION 'LINEAS_REQUIRED';
  END IF;

  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'AUTH_SIN_TENANT';
  END IF;

  -- ─── Pre-validar TODAS las líneas (fail loud) ──────────────────────────
  -- Antes había CONTINUE silencioso si una línea era inválida → el cierre
  -- se hacía con menos ventas sin avisar. Ahora aborta con LINEA_INVALIDA.
  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_idx := v_idx + 1;
    v_medio := v_linea->>'medio';
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_medio IS NULL OR trim(v_medio) = '' OR v_monto <= 0 THEN
      RAISE EXCEPTION 'LINEA_INVALIDA: linea %, medio=%, monto=%', v_idx, v_medio, v_monto;
    END IF;
  END LOOP;

  -- ─── Idempotency check ─────────────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
     WHERE rpc_name = 'crear_cierre_ventas' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  -- ─── Iterar líneas, insertar ventas, agrupar por cuenta_destino ───────
  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas)
  LOOP
    v_medio := v_linea->>'medio';
    v_monto := (v_linea->>'monto')::numeric;
    -- Sin CONTINUE acá: las líneas ya están validadas arriba. Si llegan
    -- inválidas a este loop, es un bug — preferimos crashear que silenciar.

    -- Resolver cuenta_destino: primero override por local, después global.
    -- v2: filtro por tenant + deleted_at — con el catálogo unificado por
    -- tenant, el lookup por nombre sin tenant podía cruzar catálogos.
    SELECT cuenta_destino INTO v_cuenta FROM medios_cobro
     WHERE nombre = v_medio AND local_id = p_local_id
       AND tenant_id = v_tenant_id AND deleted_at IS NULL
     LIMIT 1;
    IF NOT FOUND THEN
      SELECT cuenta_destino INTO v_cuenta FROM medios_cobro
       WHERE nombre = v_medio AND local_id IS NULL
         AND tenant_id = v_tenant_id AND deleted_at IS NULL
       LIMIT 1;
    END IF;
    -- v_cuenta puede ser NULL (medios que no impactan caja: tarjetas, online)

    -- Generar ID compatible con el frontend
    v_venta_id := _gen_id_compat('V');
    INSERT INTO ventas (id, local_id, fecha, turno, medio, monto, origen, tenant_id)
    VALUES (v_venta_id, p_local_id, p_fecha, p_turno, v_medio, v_monto, 'manual', v_tenant_id);

    v_venta_ids := array_append(v_venta_ids, v_venta_id);
    v_total := v_total + v_monto;

    -- Agrupar por cuenta_destino para movimiento consolidado
    IF v_cuenta IS NOT NULL THEN
      v_impacto := jsonb_set(
        v_impacto,
        ARRAY[v_cuenta],
        to_jsonb(COALESCE((v_impacto->>v_cuenta)::numeric, 0) + v_monto)
      );
      v_ids_por_cuenta := jsonb_set(
        v_ids_por_cuenta,
        ARRAY[v_cuenta],
        COALESCE(v_ids_por_cuenta->v_cuenta, '[]'::jsonb) || to_jsonb(v_venta_id)
      );
    END IF;
  END LOOP;

  -- Validación adicional defensive: si llegamos acá con array vacío, algo
  -- raro pasó (no debería suceder porque pre-validamos arriba).
  IF array_length(v_venta_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'NO_HAY_LINEAS_VALIDAS';
  END IF;

  -- ─── Por cada cuenta con impacto: movimiento + actualizar saldo ───────
  FOR v_cuenta_iter, v_monto_iter IN
    SELECT k AS cuenta, (v_impacto->>k)::numeric AS monto
      FROM jsonb_object_keys(v_impacto) k
  LOOP
    v_mov_id := _gen_id_compat('MOV');
    INSERT INTO movimientos (id, fecha, cuenta, tipo, cat, importe, detalle, local_id, venta_ids, tenant_id)
    VALUES (
      v_mov_id, p_fecha, v_cuenta_iter, 'Ingreso Venta', 'VENTAS',
      v_monto_iter, 'Ventas ' || p_turno || ' - ' || to_char(p_fecha, 'YYYY-MM-DD'),
      p_local_id,
      ARRAY(SELECT jsonb_array_elements_text(v_ids_por_cuenta->v_cuenta_iter)),
      v_tenant_id
    );
    v_mov_ids := array_append(v_mov_ids, v_mov_id);

    PERFORM _actualizar_saldo_caja(v_cuenta_iter, p_local_id, v_monto_iter);
  END LOOP;

  v_result := jsonb_build_object(
    'venta_ids', to_jsonb(v_venta_ids),
    'mov_ids', to_jsonb(v_mov_ids),
    'total', v_total
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('crear_cierre_ventas', p_idempotency_key, v_tenant_id, v_result)
    ON CONFLICT (rpc_name, key, tenant_id) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION crear_cierre_ventas(INTEGER, DATE, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crear_cierre_ventas(INTEGER, DATE, TEXT, JSONB, TEXT) TO authenticated;

COMMIT;
