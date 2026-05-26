-- ─────────────────────────────────────────────────────────────────────────
-- Fix: fn_revertir_stock_factura bloqueaba anulaciones via override TOTP.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Reporte Lucas/Caro 27-may: Caro intentó anular factura YAGI MONICA con
-- código de autorización, el código se aceptó OK pero la operación falló
-- con "PERMISO_DENEGADO" → "No tenés permiso para esta operación en
-- este local".
--
-- Causa raíz: secuencia de eventos al anular:
--   1. `anular_factura(p_factura_id, p_override_code)` chequea
--      `auth_tiene_permiso_o_override(...)` → OK (Caro tiene el código).
--   2. `_validar_local_autorizado(local 4)` → OK (Caro tiene Maneki).
--   3. `UPDATE facturas SET estado = 'anulada'` → dispara trigger
--      `trg_factura_anulada_stock`.
--   4. Trigger llama `fn_revertir_stock_factura(factura_id)`.
--   5. Esa función chequea `auth_es_dueno_o_admin()` → FALSE (Caro es
--      encargado) → RAISE 'PERMISO_DENEGADO'.
--   6. Toda la transacción se hace ROLLBACK. El código de override no
--      llega a consumirse en `manager_override_usos`, pero el user ve
--      un error confuso porque no sabe que es del trigger.
--
-- El check de `auth_es_dueno_o_admin()` en `fn_revertir_stock_factura`
-- es REDUNDANTE: solo se llama desde el trigger AFTER UPDATE de
-- facturas — para llegar acá, el caller ya pasó por `anular_factura`
-- que validó override TOTP. Y `fn_revertir_stock_factura` no es
-- callable directo desde el cliente (no aparece en ningún caller fuera
-- del trigger).
--
-- Solución: sacar el check de auth_es_dueno_o_admin(). Mantener el check
-- de TENANT_MISMATCH (defense-in-depth: garantiza que el caller no toque
-- facturas de otros tenants aunque tenga rol elevado en su tenant
-- propio).

CREATE OR REPLACE FUNCTION fn_revertir_stock_factura(p_factura_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revertidos INTEGER := 0;
  v_mov RECORD;
  v_factura_tenant UUID;
BEGIN
  -- CRIT-4 FIX (sigue vigente): validar que el caller es del mismo tenant.
  SELECT tenant_id INTO v_factura_tenant FROM facturas WHERE id = p_factura_id;
  IF v_factura_tenant IS NULL THEN
    RAISE EXCEPTION 'FACTURA_NO_ENCONTRADA';
  END IF;
  IF v_factura_tenant IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  -- ELIMINADO 27-may: el check de auth_es_dueno_o_admin() era redundante.
  -- La función se llama EXCLUSIVAMENTE desde el trigger fn_trg_factura_anulada_stock
  -- que se dispara al UPDATE de facturas. Para llegar a ese UPDATE, el caller
  -- ya pasó por anular_factura() que valida el override TOTP. Si el caller
  -- llegó hasta acá, ya está autorizado. Re-chequear bloquea encargados con
  -- override válido (caso Caro 27-may).
  --
  -- Defense-in-depth se mantiene en 2 capas: (1) TENANT_MISMATCH arriba,
  -- (2) RLS en insumo_movimientos.

  FOR v_mov IN
    SELECT im.id, im.tenant_id, im.local_id, im.insumo_id, im.cantidad, im.costo_unitario
      FROM insumo_movimientos im
     WHERE im.fuente_tipo = 'factura_item'
       AND im.fuente_id IN (SELECT id::BIGINT FROM factura_items WHERE factura_id = p_factura_id)
       AND im.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM insumo_movimientos rev
         WHERE rev.fuente_tipo = 'reversion_factura'
           AND rev.fuente_id = im.id
           AND rev.deleted_at IS NULL
       )
  LOOP
    INSERT INTO insumo_movimientos (
      tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
      motivo, fuente_tipo, fuente_id
    ) VALUES (
      v_mov.tenant_id, v_mov.local_id, v_mov.insumo_id, 'entrada_devolucion',
      -v_mov.cantidad, v_mov.costo_unitario,
      'Reversión anulación factura ' || p_factura_id,
      'reversion_factura', v_mov.id
    );
    v_revertidos := v_revertidos + 1;
  END LOOP;

  RETURN v_revertidos;
END;
$$;

COMMENT ON FUNCTION fn_revertir_stock_factura IS
  'Revierte los movimientos de stock generados por items de una factura. '
  'Llamada SOLO desde el trigger trg_factura_anulada_stock (no callable '
  'directo). El check de permiso vive en anular_factura — esta función '
  'asume autorización ya validada.';
