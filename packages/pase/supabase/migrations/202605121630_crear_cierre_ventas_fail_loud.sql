-- ═══════════════════════════════════════════════════════════════════════════
-- crear_cierre_ventas: fail loud en líneas inválidas en lugar de skiparlas.
--
-- Bug: la versión anterior (migration 202605111800) iteraba sobre las líneas
-- y hacía CONTINUE silencioso si una línea no tenía medio o tenía monto<=0.
-- Resultado: si el operador cargaba 3 líneas pero una tenía monto cero por
-- error de UI, el cierre se hacía con 2 ventas y nunca se enteraba.
--
-- Fix: pre-validar TODAS las líneas antes del LOOP. Si alguna es inválida,
-- RAISE EXCEPTION 'LINEA_INVALIDA' con el índice. El resto del cuerpo de
-- la función queda IGUAL que en 202605111800 — preservamos toda la lógica
-- de cuenta_destino lookup, agrupación, idempotency.
-- ═══════════════════════════════════════════════════════════════════════════

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

    -- Resolver cuenta_destino: primero override por local, después global
    SELECT cuenta_destino INTO v_cuenta FROM medios_cobro
     WHERE nombre = v_medio AND local_id = p_local_id
     LIMIT 1;
    IF NOT FOUND THEN
      SELECT cuenta_destino INTO v_cuenta FROM medios_cobro
       WHERE nombre = v_medio AND local_id IS NULL
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
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION crear_cierre_ventas(INTEGER, DATE, TEXT, JSONB, TEXT) TO authenticated;
