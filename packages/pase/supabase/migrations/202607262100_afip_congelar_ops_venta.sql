-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP — congelar mesa facturada: blindaje server-side de las OPERACIONES
-- Sesión 2026-07-26 (follow-up de 202607261700)
--
-- 202607261700 bloqueó server-side el alta/edición/baja de ÍTEMS de una mesa
-- facturada. Este archivo cierra el resto de las operaciones que cambian la
-- cuenta y que hasta ahora sólo estaban bloqueadas en pantalla:
--   - Aplicar descuento / descuento efectivo (cambia el total).
--   - Anular la venta.
--   - Unir mesas / partir cuenta / dividir por comensal (mueven ítems entre
--     ventas).
--
-- Diseño: triggers ADITIVOS (no reescriben las RPCs → no pueden romper su
-- lógica) y disparan por cualquier camino (incluidas las variantes _offline).
--
-- ⚠️ CLAVE: el cobro NO se bloquea. El flujo es facturar → después cobrar, así
-- que fn_cobrar_venta_comanda (que setea estado='cobrada', cobrada_at, propina)
-- tiene que seguir andando en una mesa facturada. Por eso el trigger de
-- ventas_pos sólo mira estado→'anulada' y los campos de descuento — nunca
-- estado='cobrada' ni total/propina.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Ítems: además de alta/edición/baja, bloquear MOVER ítems entre ventas
--        (merge/split) cuando el origen o el destino está facturado ──────────
CREATE OR REPLACE FUNCTION fn_bloquear_edicion_mesa_facturada()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT: alta de ítem nuevo en una mesa ya facturada → bloqueado.
  IF TG_OP = 'INSERT' THEN
    IF fn_venta_tiene_factura_activa(NEW.venta_id) THEN
      RAISE EXCEPTION 'VENTA_FACTURADA';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Mover el ítem a otra venta (unir mesas / partir cuenta / dividir por
    -- comensal): bloquear si el origen O el destino tiene factura activa.
    IF NEW.venta_id IS DISTINCT FROM OLD.venta_id
       AND (fn_venta_tiene_factura_activa(OLD.venta_id)
            OR fn_venta_tiene_factura_activa(NEW.venta_id)) THEN
      RAISE EXCEPTION 'VENTA_FACTURADA';
    END IF;

    -- Cambios que afectan la CUENTA (cantidad, precio, subtotal, baja/anulación).
    -- Cambios de estado de cocina (enviado_at, listo_at, estado) pasan → KDS.
    IF (NEW.cantidad          IS DISTINCT FROM OLD.cantidad
        OR NEW.precio_unitario IS DISTINCT FROM OLD.precio_unitario
        OR NEW.subtotal        IS DISTINCT FROM OLD.subtotal
        OR NEW.deleted_at      IS DISTINCT FROM OLD.deleted_at
        OR NEW.anulado_at      IS DISTINCT FROM OLD.anulado_at)
       AND fn_venta_tiene_factura_activa(NEW.venta_id) THEN
      RAISE EXCEPTION 'VENTA_FACTURADA';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- ─── 2. ventas_pos: bloquear anular + cambios de descuento (NO el cobro) ─────
CREATE OR REPLACE FUNCTION fn_bloquear_ops_venta_facturada()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Anular una venta facturada → hay que emitir NC primero.
  IF NEW.estado = 'anulada'
     AND OLD.estado IS DISTINCT FROM 'anulada'
     AND fn_venta_tiene_factura_activa(NEW.id) THEN
    RAISE EXCEPTION 'VENTA_FACTURADA';
  END IF;

  -- Cambiar el descuento de una venta facturada (mueve el total) → NC.
  -- (El cobro NO toca estos campos, así que no se bloquea.)
  IF (NEW.descuento_total       IS DISTINCT FROM OLD.descuento_total
      OR NEW.descuento_efectivo_pct IS DISTINCT FROM OLD.descuento_efectivo_pct)
     AND fn_venta_tiene_factura_activa(NEW.id) THEN
    RAISE EXCEPTION 'VENTA_FACTURADA';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bloquear_ops_venta_facturada ON ventas_pos;
CREATE TRIGGER trg_bloquear_ops_venta_facturada
  BEFORE UPDATE ON ventas_pos
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_ops_venta_facturada();

COMMENT ON FUNCTION fn_bloquear_ops_venta_facturada() IS
  'Trigger BEFORE UPDATE en ventas_pos: rechaza (VENTA_FACTURADA) anular o cambiar descuentos de una venta con factura activa. NO bloquea el cobro (estado=cobrada/propina).';

NOTIFY pgrst, 'reload schema';
