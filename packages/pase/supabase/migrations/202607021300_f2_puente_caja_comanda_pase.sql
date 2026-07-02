-- ============================================================
-- F2 — Puente caja COMANDA → PASE
--
-- Cuando comanda_fuente_de_verdad = TRUE para un local, cada
-- movimiento_caja de COMANDA (venta efectivo, retiro, depósito,
-- ajuste, venta_anulada) crea automáticamente el movimiento
-- equivalente en PASE (movimientos + saldos_caja).
--
-- Mecanismo: trigger AFTER INSERT en movimientos_caja.
-- Idempotencia: columna comanda_ref en movimientos con unique
-- partial index — si el trigger se dispara 2x por el mismo
-- movimiento_caja, el segundo INSERT es no-op.
--
-- Apertura y cierre de turno NO impactan caja de PASE (son
-- operativos, no financieros).
-- ============================================================

-- 1. Columna de trazabilidad en movimientos de PASE ─────────────────────────
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS comanda_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_comanda_ref
  ON movimientos(comanda_ref) WHERE comanda_ref IS NOT NULL;

-- 2. Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_puente_caja_comanda()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flag BOOLEAN;
  v_cuenta TEXT;
  v_mov_id TEXT;
  v_tenant_id UUID;
  v_fecha DATE;
  v_tipo_pase TEXT;
  v_cat TEXT;
  v_importe NUMERIC;
  v_detalle TEXT;
  v_rows INTEGER;
BEGIN
  -- Gate: solo bridgear si el local usa COMANDA como fuente
  SELECT comanda_fuente_de_verdad INTO v_flag
    FROM locales WHERE id = NEW.local_id;
  IF NOT COALESCE(v_flag, FALSE) THEN
    RETURN NEW;
  END IF;

  -- Apertura y cierre son operativos, no financieros
  IF NEW.tipo IN ('apertura', 'cierre') THEN
    RETURN NEW;
  END IF;

  -- Resolver cuenta_destino desde medios_cobro
  -- El POS guarda slug en metodo; buscamos slug o nombre
  SELECT mc.cuenta_destino INTO v_cuenta
    FROM medios_cobro mc
   WHERE mc.tenant_id = NEW.tenant_id
     AND (mc.local_id IS NULL OR mc.local_id = NEW.local_id)
     AND mc.deleted_at IS NULL
     AND (mc.slug = NEW.metodo OR upper(mc.nombre) = upper(NEW.metodo))
   ORDER BY mc.local_id NULLS LAST
   LIMIT 1;

  -- Sin cuenta_destino = sin impacto en caja (tarjetas, online, etc.)
  IF v_cuenta IS NULL OR v_cuenta = '' THEN
    RETURN NEW;
  END IF;

  v_fecha := (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_tenant_id := NEW.tenant_id;

  -- Mapear tipo COMANDA → tipo/cat/importe PASE
  CASE NEW.tipo
    WHEN 'venta' THEN
      v_tipo_pase := 'Ingreso Venta';
      v_cat := 'VENTAS';
      v_importe := NEW.monto;
      v_detalle := 'COMANDA venta #' || COALESCE(NEW.venta_id::TEXT, '');
    WHEN 'venta_anulada' THEN
      v_tipo_pase := 'Ingreso Venta';
      v_cat := 'VENTAS';
      v_importe := -NEW.monto;
      v_detalle := 'COMANDA anulación venta #' || COALESCE(NEW.venta_id::TEXT, '');
    WHEN 'retiro' THEN
      v_tipo_pase := 'Egreso';
      v_cat := 'CAJA';
      v_importe := -NEW.monto;
      v_detalle := 'COMANDA retiro: ' || COALESCE(NEW.motivo, '');
    WHEN 'deposito' THEN
      v_tipo_pase := 'Ingreso';
      v_cat := 'CAJA';
      v_importe := NEW.monto;
      v_detalle := 'COMANDA depósito: ' || COALESCE(NEW.motivo, '');
    WHEN 'ajuste' THEN
      v_tipo_pase := CASE WHEN NEW.monto >= 0 THEN 'Ingreso' ELSE 'Egreso' END;
      v_cat := 'CAJA';
      v_importe := NEW.monto;
      v_detalle := 'COMANDA ajuste: ' || COALESCE(NEW.motivo, '');
    ELSE
      RETURN NEW;
  END CASE;

  -- Insertar movimiento PASE (idempotente por comanda_ref)
  v_mov_id := _gen_id_compat('MOV');
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle,
    local_id, tenant_id, comanda_ref
  ) VALUES (
    v_mov_id, v_fecha, v_cuenta, v_tipo_pase, v_cat,
    v_importe, v_detalle, NEW.local_id, v_tenant_id,
    'cmov_' || NEW.id::TEXT
  )
  ON CONFLICT (comanda_ref) WHERE comanda_ref IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    PERFORM _actualizar_saldo_caja(v_cuenta, NEW.local_id, v_importe);
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Trigger ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_puente_caja_comanda ON movimientos_caja;
CREATE TRIGGER trg_puente_caja_comanda
  AFTER INSERT ON movimientos_caja
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_puente_caja_comanda();
