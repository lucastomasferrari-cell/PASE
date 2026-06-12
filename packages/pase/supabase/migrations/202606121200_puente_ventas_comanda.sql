-- ============================================================
-- 202606121200_puente_ventas_comanda.sql
-- Tier 1 #2 (informe 2026-06-11): puente ventas_pos → ventas.
-- Al cobrar una venta en COMANDA, sus pagos confirmados (neto de
-- propina) se agregan por medio en la fila diaria de `ventas`
-- (origen='comanda'). Reversible: anular/reabrir descuenta lo
-- exacto que esa venta había aportado (ventas_pos_proyecciones).
-- NO crea movimientos/saldos_caja (el efectivo del POS vive en
-- turnos_caja y sube a PASE con el retiro físico).
-- Sin backfill: arranca desde el deploy (las ventas_pos previas
-- son de prueba).
-- ============================================================

BEGIN;

-- 1) Registro de qué proyectó cada venta (idempotencia + reverso exacto)
CREATE TABLE IF NOT EXISTS ventas_pos_proyecciones (
  venta_id    BIGINT PRIMARY KEY REFERENCES ventas_pos(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  local_id    INTEGER NOT NULL,
  fecha       DATE NOT NULL,
  turno       TEXT NOT NULL,
  detalle     JSONB NOT NULL,          -- [{"medio":"EFECTIVO","monto":1234.50}, ...]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vpp_tenant_fecha ON ventas_pos_proyecciones(tenant_id, local_id, fecha);

ALTER TABLE ventas_pos_proyecciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ventas_pos_proyecciones_all ON ventas_pos_proyecciones;
CREATE POLICY ventas_pos_proyecciones_all ON ventas_pos_proyecciones
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- 2) Clave de upsert para las filas proyectadas en `ventas`
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_comanda_dia_medio
  ON ventas (tenant_id, local_id, fecha, turno, medio)
  WHERE origen = 'comanda';

-- 3) Proyectar (llamada por trigger al cobrar) -------------------------------
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
    INSERT INTO ventas (id, tenant_id, local_id, fecha, turno, medio, monto, origen)
    VALUES (
      'VC' || replace(gen_random_uuid()::text, '-', ''),
      v_venta.tenant_id, v_venta.local_id, v_fecha, v_turno, v_pago.metodo, v_pago.neto, 'comanda'
    )
    ON CONFLICT (tenant_id, local_id, fecha, turno, medio) WHERE origen = 'comanda'
    DO UPDATE SET monto = ventas.monto + EXCLUDED.monto;

    v_detalle := v_detalle || jsonb_build_object('medio', v_pago.metodo, 'monto', v_pago.neto);
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

-- 4) Revertir (anulada o reabierta después de cobrada) -----------------------
CREATE OR REPLACE FUNCTION fn_revertir_proyeccion_venta_pos(p_venta_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proj RECORD;
  v_item JSONB;
  v_filas INTEGER := 0;
BEGIN
  SELECT * INTO v_proj FROM ventas_pos_proyecciones WHERE venta_id = p_venta_id;
  IF v_proj.venta_id IS NULL THEN
    RETURN 0; -- nunca proyectó (o ya se revirtió): nada que hacer
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_proj.detalle)
  LOOP
    UPDATE ventas v
       SET monto = v.monto - (v_item->>'monto')::NUMERIC
     WHERE v.tenant_id = v_proj.tenant_id
       AND v.local_id = v_proj.local_id
       AND v.fecha = v_proj.fecha
       AND v.turno = v_proj.turno
       AND v.medio = v_item->>'medio'
       AND v.origen = 'comanda';
    v_filas := v_filas + 1;
  END LOOP;

  -- Filas que quedaron en 0 exacto → limpiar (no ensuciar EERR con $0).
  DELETE FROM ventas v
   WHERE v.tenant_id = v_proj.tenant_id
     AND v.local_id = v_proj.local_id
     AND v.fecha = v_proj.fecha
     AND v.turno = v_proj.turno
     AND v.origen = 'comanda'
     AND abs(v.monto) < 0.005;

  DELETE FROM ventas_pos_proyecciones WHERE venta_id = p_venta_id;
  RETURN v_filas;
END;
$$;
REVOKE ALL ON FUNCTION fn_revertir_proyeccion_venta_pos(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_revertir_proyeccion_venta_pos(BIGINT) TO authenticated, service_role;

-- 5) Triggers (mismo patrón que trg_venta_cobrada_stock) ---------------------
CREATE OR REPLACE FUNCTION fn_trg_venta_pos_proyectar()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = 'cobrada' AND (OLD.estado IS NULL OR OLD.estado <> 'cobrada') THEN
    PERFORM fn_proyectar_venta_pos(NEW.id);
  ELSIF OLD.estado = 'cobrada' AND NEW.estado <> 'cobrada' THEN
    -- anulada O reabierta: descontar exactamente lo aportado
    PERFORM fn_revertir_proyeccion_venta_pos(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venta_pos_proyectar ON ventas_pos;
CREATE TRIGGER trg_venta_pos_proyectar
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_venta_pos_proyectar();

COMMIT;
