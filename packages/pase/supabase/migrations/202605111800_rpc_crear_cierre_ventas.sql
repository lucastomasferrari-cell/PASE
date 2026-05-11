-- F1 del plan sunny-creek: refactor de Ventas.tsx::guardar() a RPC
-- atómica. Hoy hace 3 inserts secuenciales sin transacción (ventas +
-- movimientos + saldos_caja). Si Internet se corta a mitad, caja
-- queda "fantasma": venta cargada sin movimiento.
--
-- También introduce la tabla `idempotency_keys` para soporte de
-- convención C1 (protección contra doble-click / retry). Esta tabla
-- la usarán otras RPCs financieras en futuras migrations.

-- ─── Tabla idempotency_keys ──────────────────────────────────────────────
-- Almacena el resultado de una RPC junto con el key opcional que el
-- cliente envía. Si la misma RPC se llama de nuevo con el mismo key
-- (típicamente por doble-click), devolvemos el resultado cacheado en
-- lugar de re-ejecutar.
--
-- TTL natural: ~30 días. La limpieza periódica queda como deuda menor
-- (cron job o pg_cron). Mientras tanto la tabla crece despacio.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  rpc_name TEXT NOT NULL,
  key TEXT NOT NULL,
  tenant_id UUID,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rpc_name, key)
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- RLS: cada tenant ve solo sus keys (defensive — los keys son UUIDs
-- aleatorios y no contienen data sensible, pero la disciplina vale).
CREATE POLICY "idempotency_keys_mt" ON idempotency_keys FOR ALL TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id())
  WITH CHECK (auth_es_superadmin() OR tenant_id = auth_tenant_id());

GRANT SELECT, INSERT ON idempotency_keys TO authenticated;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_tenant ON idempotency_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);

-- ─── Helper interno: generar IDs en el mismo formato que el frontend ────
-- Formato: <prefix>-<epoch_ms>-<rand_4ch>. Coherente con genId() de
-- src/lib/utils.ts:54. La RPC genera múltiples IDs por llamada — la
-- aleatoriedad evita colisiones intra-transacción.
CREATE OR REPLACE FUNCTION _gen_id_compat(p_prefix TEXT) RETURNS TEXT
LANGUAGE plpgsql VOLATILE
AS $$
BEGIN
  RETURN p_prefix || '-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
         || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);
END;
$$;

-- ─── RPC crear_cierre_ventas ─────────────────────────────────────────────
-- Reemplaza el flow no-atómico de Ventas.tsx::guardar():
--   1. Inserta una venta por cada línea (medio + monto).
--   2. Agrupa por cuenta_destino (lookup en medios_cobro: override por
--      local primero, después global).
--   3. Para cada cuenta con impacto: inserta UN movimiento consolidado
--      (con venta_ids[]) y actualiza saldos_caja via _actualizar_saldo_caja.
--   4. Si cualquier paso falla, ROLLBACK — no quedan estados parciales.
--
-- p_idempotency_key: si se pasa y ya existe en idempotency_keys, devuelve
-- el resultado cacheado sin re-ejecutar. Si no, ejecuta y guarda.
--
-- SECURITY INVOKER: respeta las RLS del caller. Las RLS de ventas /
-- movimientos / saldos_caja ya validan tenant_id + local_id.
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
    v_monto := COALESCE((v_linea->>'monto')::numeric, 0);
    IF v_medio IS NULL OR trim(v_medio) = '' OR v_monto <= 0 THEN CONTINUE; END IF;

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

    -- Helper race-safe: hace INSERT ON CONFLICT DO UPDATE
    PERFORM _actualizar_saldo_caja(v_cuenta_iter, p_local_id, v_monto_iter);
  END LOOP;

  v_result := jsonb_build_object(
    'venta_ids', to_jsonb(v_venta_ids),
    'mov_ids', to_jsonb(v_mov_ids),
    'total', v_total
  );

  -- ─── Guardar idempotency record (al final, después de toda la lógica) ─
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('crear_cierre_ventas', p_idempotency_key, v_tenant_id, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION crear_cierre_ventas(INTEGER, DATE, TEXT, JSONB, TEXT) TO authenticated;
