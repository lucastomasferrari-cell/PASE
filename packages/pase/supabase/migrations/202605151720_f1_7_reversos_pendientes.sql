-- ═══════════════════════════════════════════════════════════════════════════
-- F1.7 — Cola de reversos pendientes
--
-- Sprint 8 dejó deuda explícita: si una venta cobrada se anula PERO no hay
-- turno abierto en el local, el trigger fn_trg_revertir_movimientos_al_anular_venta
-- emite RAISE NOTICE y NO genera el reverso. La caja queda con dinero
-- "fantasma" hasta que se ajusta a mano vía Auditoría.
--
-- Solución F1.7:
--   1. Tabla `reversos_pendientes` que almacena cada reverso pendiente.
--   2. Trigger viejo modificado: si NO hay turno abierto, encola en lugar
--      de saltear silenciosamente.
--   3. RPC fn_procesar_reversos_pendientes_comanda(p_turno_id): drena la
--      cola del local al ABRIR un turno nuevo, genera los movimientos
--      compensatorios reales en ese turno.
--   4. Hook automático: trigger AFTER INSERT/UPDATE en turnos_caja que
--      llama a la RPC cuando el turno pasa a 'abierto'.
--
-- Cierre del agujero "dinero fantasma".
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla reversos_pendientes ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reversos_pendientes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NOT NULL REFERENCES locales(id),
  venta_id      BIGINT NOT NULL REFERENCES ventas_pos(id),
  pago_id       BIGINT NOT NULL REFERENCES ventas_pos_pagos(id),
  empleado_id   UUID NULL REFERENCES rrhh_empleados(id),
  metodo        TEXT NOT NULL,
  monto         NUMERIC(12,2) NOT NULL,
  motivo        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ NULL,
  processed_turno_id BIGINT NULL REFERENCES turnos_caja(id),
  -- Idempotency: derivado venta_id + pago_id. Si el trigger se ejecuta 2x,
  -- el UNIQUE lo bloquea.
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_reversos_pendientes_local_pending
  ON reversos_pendientes(local_id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reversos_pendientes_venta
  ON reversos_pendientes(venta_id);

COMMENT ON TABLE reversos_pendientes IS
  'F1.7 (2026-05-15): cola de reversos cuando se anula venta cobrada sin turno abierto. Se drena al abrir próximo turno via fn_procesar_reversos_pendientes_comanda.';

-- ─── 2. RLS dual ───────────────────────────────────────────────────────────
ALTER TABLE reversos_pendientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reversos_pendientes_select ON reversos_pendientes;
CREATE POLICY reversos_pendientes_select ON reversos_pendientes FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND local_id = ANY(auth_locales_visibles())
    )
  );
DROP POLICY IF EXISTS reversos_pendientes_service ON reversos_pendientes;
CREATE POLICY reversos_pendientes_service ON reversos_pendientes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── 3. Trigger reescrito: encola si no hay turno ─────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_revertir_movimientos_al_anular_venta()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pago RECORD;
  v_turno_id BIGINT;
  v_empleado UUID;
BEGIN
  IF NEW.estado != 'anulada' OR OLD.estado != 'cobrada' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_turno_id
  FROM turnos_caja
  WHERE local_id = NEW.local_id AND estado = 'abierto'
  LIMIT 1;

  v_empleado := NEW.cajero_id;
  IF v_empleado IS NULL AND v_turno_id IS NOT NULL THEN
    SELECT cajero_id INTO v_empleado FROM turnos_caja WHERE id = v_turno_id;
  END IF;

  FOR v_pago IN
    SELECT id, metodo, monto, cobrado_por
    FROM ventas_pos_pagos
    WHERE venta_id = NEW.id
      AND estado = 'confirmado'
      AND deleted_at IS NULL
  LOOP
    IF v_turno_id IS NOT NULL THEN
      -- Caso normal: hay turno abierto, insertar movimiento compensatorio.
      INSERT INTO movimientos_caja (
        tenant_id, local_id, turno_caja_id, empleado_id,
        tipo, monto, metodo, motivo, venta_id,
        idempotency_key
      ) VALUES (
        NEW.tenant_id, NEW.local_id, v_turno_id,
        COALESCE(v_pago.cobrado_por, v_empleado),
        'venta_anulada',
        -ABS(v_pago.monto),
        v_pago.metodo,
        'Reverso automático por anulación de venta #' || NEW.numero_local,
        NEW.id,
        'reverso_' || NEW.id || '_' || v_pago.id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
    ELSE
      -- F1.7: sin turno abierto → encolar en reversos_pendientes.
      INSERT INTO reversos_pendientes (
        tenant_id, local_id, venta_id, pago_id, empleado_id,
        metodo, monto, motivo, idempotency_key
      ) VALUES (
        NEW.tenant_id, NEW.local_id, NEW.id, v_pago.id,
        COALESCE(v_pago.cobrado_por, v_empleado),
        v_pago.metodo, v_pago.monto,
        'Reverso pendiente por anulación de venta #' || NEW.numero_local,
        'reverso_' || NEW.id || '_' || v_pago.id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- ─── 4. RPC drenar cola al abrir turno ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_procesar_reversos_pendientes_comanda(
  p_turno_id BIGINT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_local_id INTEGER;
  v_tenant_id UUID;
  v_estado TEXT;
  v_reverso RECORD;
  v_count INTEGER := 0;
BEGIN
  SELECT local_id, tenant_id, estado INTO v_local_id, v_tenant_id, v_estado
    FROM turnos_caja WHERE id = p_turno_id;
  IF v_local_id IS NULL THEN RAISE EXCEPTION 'TURNO_NO_ENCONTRADO'; END IF;
  IF v_estado != 'abierto' THEN RAISE EXCEPTION 'TURNO_NO_ABIERTO'; END IF;

  FOR v_reverso IN
    SELECT id, pago_id, venta_id, empleado_id, metodo, monto, motivo, idempotency_key
    FROM reversos_pendientes
    WHERE local_id = v_local_id
      AND processed_at IS NULL
  LOOP
    INSERT INTO movimientos_caja (
      tenant_id, local_id, turno_caja_id, empleado_id,
      tipo, monto, metodo, motivo, venta_id,
      idempotency_key
    ) VALUES (
      v_tenant_id, v_local_id, p_turno_id,
      v_reverso.empleado_id,
      'venta_anulada',
      -ABS(v_reverso.monto),
      v_reverso.metodo,
      v_reverso.motivo,
      v_reverso.venta_id,
      v_reverso.idempotency_key
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE reversos_pendientes
       SET processed_at = NOW(), processed_turno_id = p_turno_id
     WHERE id = v_reverso.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION fn_procesar_reversos_pendientes_comanda(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_procesar_reversos_pendientes_comanda(BIGINT) TO authenticated, service_role;

-- ─── 5. Trigger automático al abrir turno ──────────────────────────────────
-- Cuando se inserta un turno abierto (o se reabre uno), drena la cola.
-- SECURITY DEFINER hereda permisos. La función ya hace EXECUTE con tenant + local.
CREATE OR REPLACE FUNCTION fn_trg_drenar_reversos_al_abrir_turno()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.estado = 'abierto' AND (TG_OP = 'INSERT' OR OLD.estado != 'abierto') THEN
    PERFORM fn_procesar_reversos_pendientes_comanda(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drenar_reversos_al_abrir_turno ON turnos_caja;
CREATE TRIGGER trg_drenar_reversos_al_abrir_turno
  AFTER INSERT OR UPDATE OF estado ON turnos_caja
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_drenar_reversos_al_abrir_turno();

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN F1.7
-- ═══════════════════════════════════════════════════════════════════════════
