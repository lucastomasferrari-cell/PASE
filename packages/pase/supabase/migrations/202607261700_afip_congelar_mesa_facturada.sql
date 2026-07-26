-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP — congelar mesa facturada + soporte de notas de crédito
-- Sesión 2026-07-26
--
-- Contexto: en el POS ahora se puede EMITIR la factura antes de cobrar
-- (llevás la cuenta a la mesa, el cliente decide cómo paga, después cobrás).
-- Al emitir, la mesa queda "congelada": no se puede sumar/restar/modificar
-- ni anular ítems. Para modificarla hay que generar una nota de crédito
-- (NC), que cancela la factura y descongela la venta.
--
-- Este archivo hace 3 cosas:
--   1. Amplía el CHECK de afip_facturas.tipo_comprobante para aceptar los
--      tipos de NOTA DE CRÉDITO (3=NC A, 8=NC B, 13=NC C). Sin esto, el
--      INSERT de la NC fallaba (quedaba emitida en AFIP pero no persistida).
--   2. fn_venta_tiene_factura_activa(venta_id): true si la venta tiene una
--      factura viva (más facturas aprobadas que NC aprobadas → hay un
--      comprobante sin anular).
--   3. Trigger en ventas_pos_items que RECHAZA cambios que afectan la cuenta
--      (alta, cambio de cantidad/precio, baja/anulación) cuando la venta
--      tiene factura activa. Deja pasar cambios de estado de cocina
--      (enviado/listo) para no romper el KDS.
--
-- Sólo afecta a COMANDA (ventas_pos_items / afip_facturas). PASE usa otras
-- tablas (ventas / facturas de proveedor).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. CHECK: aceptar tipos de NOTA DE CRÉDITO ────────────────────────────
ALTER TABLE afip_facturas DROP CONSTRAINT IF EXISTS afip_facturas_tipo_comprobante_check;
ALTER TABLE afip_facturas ADD CONSTRAINT afip_facturas_tipo_comprobante_check
  CHECK (tipo_comprobante IN (1, 2, 3, 6, 7, 8, 11, 12, 13, 51, 56, 61, 66, 81, 86, 91, 96));

COMMENT ON COLUMN afip_facturas.tipo_comprobante IS
  'Código AFIP. Facturas: 1=A, 6=B, 11=C. Notas de crédito: 3=NC A, 8=NC B, 13=NC C. Notas de débito: 2/7/12.';

-- ─── 2. ¿La venta tiene una factura activa (sin anular por NC)? ─────────────
-- Factura activa ⇔ #facturas aprobadas (1/6/11) > #NC aprobadas (3/8/13).
-- El flujo es lineal: factura → NC (cancela) → factura nueva → NC → …, así
-- que la diferencia de conteos indica si hay un comprobante vivo.
-- SECURITY INVOKER: corre con los permisos del que edita el ítem (el cajero
-- ve las facturas de su tenant por RLS; service_role las ve todas). No expone
-- datos — devuelve un boolean por venta_id.
CREATE OR REPLACE FUNCTION fn_venta_tiene_factura_activa(p_venta_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    COUNT(*) FILTER (WHERE tipo_comprobante IN (1, 6, 11) AND estado = 'aprobada')
      > COUNT(*) FILTER (WHERE tipo_comprobante IN (3, 8, 13) AND estado = 'aprobada'),
    FALSE)
  FROM afip_facturas
  WHERE venta_pos_id = p_venta_id;
$$;

COMMENT ON FUNCTION fn_venta_tiene_factura_activa(BIGINT) IS
  'True si la venta_pos tiene una factura electrónica viva (sin anular por NC). Usado por el trigger que congela la mesa facturada.';

-- ─── 3. Trigger: congelar ítems de una mesa facturada ──────────────────────
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

  -- UPDATE: sólo bloqueo cambios que afectan la CUENTA (cantidad, precio,
  -- subtotal, baja/anulación). Cambios de estado de cocina (enviado_at,
  -- listo_at, estado) pasan, para no romper el KDS de una mesa facturada.
  IF TG_OP = 'UPDATE' THEN
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

DROP TRIGGER IF EXISTS trg_bloquear_edicion_mesa_facturada ON ventas_pos_items;
CREATE TRIGGER trg_bloquear_edicion_mesa_facturada
  BEFORE INSERT OR UPDATE ON ventas_pos_items
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_edicion_mesa_facturada();

COMMENT ON FUNCTION fn_bloquear_edicion_mesa_facturada() IS
  'Trigger BEFORE INSERT/UPDATE en ventas_pos_items: rechaza (VENTA_FACTURADA) cambios que afectan la cuenta cuando la venta tiene factura activa. Se destraba emitiendo una NC.';

NOTIFY pgrst, 'reload schema';
