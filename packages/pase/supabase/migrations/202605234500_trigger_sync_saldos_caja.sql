-- ═══════════════════════════════════════════════════════════════════════════
-- C4-F16: Trigger sincronizador saldos_caja ⇆ movimientos (ledger=autoridad)
--
-- ESTÁNDAR INDUSTRIA aplicado:
--   - Square, Toast, Shopify, QuickBooks: ledger=autoridad, cache=derivado.
--   - El cache (saldos_caja) es función matemática de movimientos:
--       saldo = Σ importe FILTER (WHERE NOT anulado) por (cuenta, local_id)
--   - Mantenido por trigger AFTER INSERT/UPDATE/DELETE en movimientos.
--
-- ANTES de esta migration (deuda C4-F16):
--   - saldos_caja se actualizaba MANUALMENTE por cada RPC que tocaba plata.
--   - Si una RPC tenía bug (ej. crear_gasto_empleado con signo invertido) o
--     si alguien hacía cambios por fuera (Studio SQL, scripts), el cache se
--     desfasaba para siempre y nadie se enteraba.
--   - 9 desfases conocidos al 23-may, sumando ~$54M en valor absoluto.
--
-- DESPUÉS:
--   - Cualquier cambio en movimientos sincroniza el cache automáticamente.
--   - Bugs futuros de signo/duplicación se ven inmediatamente en pantalla.
--   - _actualizar_saldo_caja queda como NOOP (solo lee y valida) — las RPCs
--     existentes siguen funcionando sin cambios.
--
-- DRIFT HISTÓRICO: se preserva con movs de ajuste explícitos insertados ANTES
-- de activar el trigger (script de aplicación). Cada ajuste tiene detalle
-- explicativo y queda auditable en el ledger. El cache final post-trigger es
-- IDÉNTICO al cache pre-migration para cada (local, cuenta) → ninguna pantalla
-- cambia visualmente, pero el ledger ahora es matemáticamente consistente.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Función del trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_sync_saldos_caja()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  -- INSERT y UPDATE: sincronizar la cuenta NEW
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT tenant_id INTO v_tenant FROM locales WHERE id = NEW.local_id;
    IF v_tenant IS NULL THEN
      SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
    END IF;
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      NEW.cuenta, NEW.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = NEW.local_id AND cuenta = NEW.cuenta AND NOT anulado),
      v_tenant
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  -- UPDATE con cambio de cuenta o local: sincronizar ADEMÁS el OLD
  IF TG_OP = 'UPDATE' AND (OLD.cuenta <> NEW.cuenta OR OLD.local_id <> NEW.local_id) THEN
    SELECT tenant_id INTO v_tenant FROM locales WHERE id = OLD.local_id;
    IF v_tenant IS NULL THEN
      SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
    END IF;
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      OLD.cuenta, OLD.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = OLD.local_id AND cuenta = OLD.cuenta AND NOT anulado),
      v_tenant
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  -- DELETE: sincronizar OLD
  IF TG_OP = 'DELETE' THEN
    SELECT tenant_id INTO v_tenant FROM locales WHERE id = OLD.local_id;
    IF v_tenant IS NULL THEN
      SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
    END IF;
    INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
    VALUES (
      OLD.cuenta, OLD.local_id,
      (SELECT COALESCE(SUM(importe), 0)
         FROM movimientos
        WHERE local_id = OLD.local_id AND cuenta = OLD.cuenta AND NOT anulado),
      v_tenant
    )
    ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ─── 2. Trigger ────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_sync_saldos_caja ON movimientos;
CREATE TRIGGER trg_sync_saldos_caja
AFTER INSERT OR UPDATE OR DELETE ON movimientos
FOR EACH ROW EXECUTE FUNCTION fn_trg_sync_saldos_caja();

-- ─── 3. _actualizar_saldo_caja: NOOP compat ─────────────────────────────────
-- Mantiene la firma para compat con RPCs existentes (crear_gasto_empleado,
-- transferencia_cuentas, registrar_adelanto, pagar_factura, pagar_remito,
-- pagar_sueldo, etc.). Antes hacía el UPSERT del cache; ahora solo LEE el
-- cache (que ya fue sincronizado por el trigger del INSERT/UPDATE anterior)
-- y aplica el check SALDO_INSUFICIENTE. p_delta queda ignorado porque el
-- cache ya refleja el cambio si el caller hizo el INSERT en movimientos antes.
CREATE OR REPLACE FUNCTION _actualizar_saldo_caja(
  p_cuenta text,
  p_local_id integer,
  p_delta numeric,
  p_permitir_negativo boolean DEFAULT true
) RETURNS numeric
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_saldo numeric;
BEGIN
  SELECT COALESCE(saldo, 0) INTO v_saldo
    FROM saldos_caja
   WHERE cuenta = p_cuenta AND local_id = p_local_id;

  v_saldo := COALESCE(v_saldo, 0);

  IF v_saldo < 0 AND NOT p_permitir_negativo THEN
    RAISE EXCEPTION 'SALDO_INSUFICIENTE';
  END IF;

  -- Auditoría defensiva (igual que versión anterior)
  IF v_saldo < 0 THEN
    BEGIN
      INSERT INTO auditoria (tabla, accion, detalle, fecha, tenant_id)
      VALUES ('saldos_caja', 'WARN_SALDO_NEGATIVO',
        jsonb_build_object(
          'cuenta', p_cuenta, 'local_id', p_local_id,
          'saldo_final', v_saldo, 'delta_ignorado', p_delta,
          'usuario_id', auth_usuario_id()
        )::text, now(),
        (SELECT tenant_id FROM locales WHERE id = p_local_id));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN v_saldo;
END;
$$;

NOTIFY pgrst, 'reload schema';
