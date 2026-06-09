-- 202606091500_fix_override_caja_venta_id_nullable.sql
--
-- BUG (09-jun, descubierto por el ensayo general de COMANDA): un RETIRO GRANDE
-- de caja (>$5000) con autorización de manager FALLABA en producción.
--
-- Causa: fn_movimiento_caja_comanda, al registrar el override del retiro grande,
-- inserta en ventas_pos_overrides con venta_id=NULL y accion='retiro_caja'. Eso
-- violaba DOS constraints:
--   1. venta_id era NOT NULL.
--   2. el CHECK de accion NO incluía 'retiro_caja'.
-- → la RPC tiraba "null value in column venta_id ... violates not-null".
--
-- Fix (solo schema, la RPC ya inserta lo correcto):
--   - venta_id pasa a NULLABLE (un override de caja no cuelga de una venta).
--   - se agregan 'retiro_caja' y 'deposito_caja' al CHECK de accion.
--   - guard nuevo: venta_id solo puede ser NULL para overrides de caja; los
--     overrides de VENTA siguen exigiendo venta_id (no se afloja su integridad).

ALTER TABLE ventas_pos_overrides ALTER COLUMN venta_id DROP NOT NULL;

ALTER TABLE ventas_pos_overrides DROP CONSTRAINT IF EXISTS ventas_pos_overrides_accion_check;
ALTER TABLE ventas_pos_overrides ADD CONSTRAINT ventas_pos_overrides_accion_check
  CHECK (accion = ANY (ARRAY[
    'void','comp','discount','refund','reopen','transfer_table',
    'cambio_mozo','merge_mesas','split_check','retiro_caja','deposito_caja'
  ]));

ALTER TABLE ventas_pos_overrides DROP CONSTRAINT IF EXISTS ventas_pos_overrides_venta_id_required;
ALTER TABLE ventas_pos_overrides ADD CONSTRAINT ventas_pos_overrides_venta_id_required
  CHECK (venta_id IS NOT NULL OR accion IN ('retiro_caja','deposito_caja'));

NOTIFY pgrst, 'reload schema';
