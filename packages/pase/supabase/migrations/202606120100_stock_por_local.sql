-- ============================================================
-- 202606120100_stock_por_local.sql
-- Tier 1 #1 (informe 2026-06-11): stock por (insumo, local).
-- - Tabla cache insumo_stock_local mantenida por el trigger del ledger.
-- - insumos.stock_actual SE CONSERVA como total global del tenant (semántica actual).
-- - Backfill desde insumo_movimientos (ya tiene local_id).
-- - Transferencias validan contra el saldo del local origen.
-- - fn_recalcular_* reconstruyen ambas caches.
-- NOTA: las versiones vigentes de fn_recalcular_stock_insumo (202605292000,
-- fix service-role) y fn_recalcular_stock_todos (202605212200, CRIT-5)
-- traen guards de seguridad cross-tenant — se CONSERVAN acá (no regresionar).
-- ============================================================

BEGIN;

-- 1) Tabla cache por local ------------------------------------------------
CREATE TABLE IF NOT EXISTS insumo_stock_local (
  tenant_id   UUID NOT NULL,
  insumo_id   BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  local_id    INTEGER NOT NULL,
  cantidad    NUMERIC(12,4) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (insumo_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_isl_tenant_local ON insumo_stock_local(tenant_id, local_id);

ALTER TABLE insumo_stock_local ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insumo_stock_local_all ON insumo_stock_local;
CREATE POLICY insumo_stock_local_all ON insumo_stock_local
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- 2) Trigger del ledger: mantiene cache global (igual que hoy) + cache por local
CREATE OR REPLACE FUNCTION fn_trg_insumo_mov_update_stock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_stock_antes NUMERIC(12, 4);
  v_stock_despues NUMERIC(12, 4);
BEGIN
  SELECT stock_actual INTO v_stock_antes FROM insumos WHERE id = NEW.insumo_id FOR UPDATE;
  v_stock_antes := COALESCE(v_stock_antes, 0);
  v_stock_despues := v_stock_antes + NEW.cantidad;

  NEW.stock_antes := v_stock_antes;
  NEW.stock_despues := v_stock_despues;

  UPDATE insumos SET
    stock_actual = v_stock_despues,
    updated_at = NOW()
  WHERE id = NEW.insumo_id;

  IF v_stock_despues <= 0 THEN
    UPDATE insumos SET stock_disponible = FALSE
     WHERE id = NEW.insumo_id AND stock_disponible = TRUE;
  ELSE
    UPDATE insumos SET stock_disponible = TRUE
     WHERE id = NEW.insumo_id AND stock_disponible = FALSE;
  END IF;

  -- NUEVO: cache por local (solo movimientos con local)
  IF NEW.local_id IS NOT NULL THEN
    INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
    VALUES (NEW.tenant_id, NEW.insumo_id, NEW.local_id, NEW.cantidad)
    ON CONFLICT (insumo_id, local_id) DO UPDATE
      SET cantidad   = insumo_stock_local.cantidad + EXCLUDED.cantidad,
          updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$;
-- (el trigger trg_insumo_mov_update_stock ya existe y apunta a esta función; no se recrea)

-- 3) Recalc defensivo: reconstruye ambas caches desde el ledger ------------
-- Base: versión vigente 202605292000 (guard cross-tenant que permite service_role)
-- + reconstrucción de la cache per-local.
CREATE OR REPLACE FUNCTION fn_recalcular_stock_insumo(p_insumo_id BIGINT)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC(12, 4);
  v_tenant_id UUID;
BEGIN
  -- Guard vigente (audit F2B #12 + fix 29-may): defense-in-depth cross-tenant,
  -- permitiendo service_role (auth_tenant_id() NULL).
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  IF NOT auth_es_superadmin()
     AND auth_tenant_id() IS NOT NULL
     AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  SELECT COALESCE(SUM(cantidad), 0) INTO v_total
    FROM insumo_movimientos
   WHERE insumo_id = p_insumo_id AND deleted_at IS NULL;

  UPDATE insumos SET stock_actual = v_total, updated_at = NOW()
   WHERE id = p_insumo_id;

  -- por local: borrar y reconstruir las filas de este insumo
  DELETE FROM insumo_stock_local WHERE insumo_id = p_insumo_id;
  INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
  SELECT im.tenant_id, im.insumo_id, im.local_id, SUM(im.cantidad)
    FROM insumo_movimientos im
   WHERE im.insumo_id = p_insumo_id
     AND im.local_id IS NOT NULL
     AND im.deleted_at IS NULL
   GROUP BY im.tenant_id, im.insumo_id, im.local_id;

  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION fn_recalcular_stock_insumo(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_recalcular_stock_insumo(BIGINT) TO authenticated;

-- Base: versión vigente 202605212200 (CRIT-5: validar p_tenant_id vs caller)
-- + reconstrucción de la cache per-local.
CREATE OR REPLACE FUNCTION fn_recalcular_stock_todos(p_tenant_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_caller_tenant UUID;
  v_count INTEGER := 0;
BEGIN
  v_caller_tenant := auth_tenant_id();
  IF v_caller_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  -- CRIT-5 (se conserva): validar que el p_tenant_id pasado coincide con el
  -- del caller (excepto superadmin, que puede cruzar tenants).
  IF p_tenant_id IS NOT NULL
     AND p_tenant_id IS DISTINCT FROM v_caller_tenant
     AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  v_tenant_id := COALESCE(p_tenant_id, v_caller_tenant);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_TENANT_RESOLVED'; END IF;

  WITH totales AS (
    SELECT insumo_id, COALESCE(SUM(cantidad), 0) AS total
      FROM insumo_movimientos
     WHERE deleted_at IS NULL
       AND tenant_id = v_tenant_id
     GROUP BY insumo_id
  )
  UPDATE insumos i SET stock_actual = t.total, updated_at = NOW()
    FROM totales t WHERE i.id = t.insumo_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM insumo_stock_local WHERE tenant_id = v_tenant_id;
  INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
  SELECT im.tenant_id, im.insumo_id, im.local_id, SUM(im.cantidad)
    FROM insumo_movimientos im
   WHERE im.tenant_id = v_tenant_id
     AND im.local_id IS NOT NULL
     AND im.deleted_at IS NULL
   GROUP BY im.tenant_id, im.insumo_id, im.local_id;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION fn_recalcular_stock_todos(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_recalcular_stock_todos(UUID) TO authenticated;

-- 4) Backfill inicial desde el ledger (todos los tenants) ------------------
INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
SELECT im.tenant_id, im.insumo_id, im.local_id, SUM(im.cantidad)
  FROM insumo_movimientos im
 WHERE im.local_id IS NOT NULL
   AND im.deleted_at IS NULL
 GROUP BY im.tenant_id, im.insumo_id, im.local_id
ON CONFLICT (insumo_id, local_id) DO UPDATE
  SET cantidad = EXCLUDED.cantidad, updated_at = NOW();

-- 5) Transferencias: validar contra el saldo del LOCAL ORIGEN --------------
CREATE OR REPLACE FUNCTION fn_transferir_stock_local(
  p_insumo_id BIGINT,
  p_local_origen_id INTEGER,
  p_local_destino_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_insumo_nombre TEXT;
  v_costo NUMERIC;
  v_transf_id BIGINT;
  v_mov_origen_id BIGINT;
  v_mov_destino_id BIGINT;
  v_stock_origen NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;
  IF p_local_origen_id = p_local_destino_id THEN
    RAISE EXCEPTION 'LOCALES_IGUALES';
  END IF;

  SELECT nombre, COALESCE(costo_actual, 0)
    INTO v_insumo_nombre, v_costo
    FROM insumos
   WHERE id = p_insumo_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL;
  IF v_insumo_nombre IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_origen_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_destino_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin()
          OR p_local_origen_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_ORIGEN';
  END IF;

  -- NUEVO: el saldo que importa es el del local origen, no el global
  SELECT COALESCE(cantidad, 0) INTO v_stock_origen
    FROM insumo_stock_local
   WHERE insumo_id = p_insumo_id AND local_id = p_local_origen_id;
  IF COALESCE(v_stock_origen, 0) < p_cantidad THEN
    RAISE EXCEPTION 'STOCK_INSUFICIENTE';
  END IF;

  INSERT INTO stock_transferencias (
    tenant_id, insumo_id, local_origen_id, local_destino_id,
    cantidad, costo_unitario, motivo, usuario_id
  ) VALUES (
    v_tenant_id, p_insumo_id, p_local_origen_id, p_local_destino_id,
    p_cantidad, v_costo, NULLIF(trim(p_motivo),''),
    NULL::INTEGER
  ) RETURNING id INTO v_transf_id;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, p_local_origen_id, p_insumo_id, 'transferencia_local',
    -p_cantidad, v_costo,
    'Transfer a local ' || p_local_destino_id || COALESCE(' — ' || p_motivo, ''),
    'stock_transferencia', v_transf_id
  ) RETURNING id INTO v_mov_origen_id;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, p_local_destino_id, p_insumo_id, 'transferencia_local',
    p_cantidad, v_costo,
    'Transfer desde local ' || p_local_origen_id || COALESCE(' — ' || p_motivo, ''),
    'stock_transferencia', v_transf_id
  ) RETURNING id INTO v_mov_destino_id;

  UPDATE stock_transferencias SET
    movimiento_origen_id = v_mov_origen_id,
    movimiento_destino_id = v_mov_destino_id
  WHERE id = v_transf_id;

  RETURN v_transf_id;
END;
$$;
REVOKE ALL ON FUNCTION fn_transferir_stock_local(BIGINT, INTEGER, INTEGER, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_transferir_stock_local(BIGINT, INTEGER, INTEGER, NUMERIC, TEXT) TO authenticated;

COMMIT;
