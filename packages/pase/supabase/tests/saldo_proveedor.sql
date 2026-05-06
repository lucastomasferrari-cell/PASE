-- ─────────────────────────────────────────────────────────────────────────
-- Test manual de triggers atómicos para proveedores.saldo.
-- Migration: 202605070900_saldo_proveedor_triggers.sql
--
-- Cómo correr: pegar todo en el SQL editor de Supabase. Empieza con BEGIN
-- y termina con ROLLBACK; nada queda persistido. Cada bloque imprime con
-- RAISE NOTICE el saldo después de cada operación. Si los valores
-- coinciden con los esperados, los triggers funcionan.
--
-- Si algún assert falla, RAISE EXCEPTION corta la transacción y muestra
-- el valor leído.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- Necesitamos un tenant válido. Reutilizamos Neko (slug='neko').
DO $$
DECLARE
  v_tenant uuid;
  v_local int := 1;       -- Neko Villa Crespo
  v_prov int;
  v_saldo numeric;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'neko' LIMIT 1;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'tenant neko no encontrado'; END IF;

  -- Crear proveedor de prueba
  INSERT INTO proveedores (nombre, cuit, cat, estado, tenant_id)
  VALUES ('TEST_TRIGGER_SALDO', '99-99999999-9', 'TEST', 'Activo', v_tenant)
  RETURNING id INTO v_prov;

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 0 (proveedor recién creado): saldo=%, esperado=0', v_saldo;
  IF COALESCE(v_saldo, 0) <> 0 THEN RAISE EXCEPTION 'FAIL paso 0'; END IF;

  -- Paso 1: insertar 2 facturas pendientes
  INSERT INTO facturas (id, prov_id, local_id, total, estado, tipo, pagos, tenant_id, nro, fecha)
  VALUES ('TEST-F1', v_prov, v_local, 10000, 'pendiente', 'factura', '[]'::jsonb, v_tenant, 'F1', CURRENT_DATE);
  INSERT INTO facturas (id, prov_id, local_id, total, estado, tipo, pagos, tenant_id, nro, fecha)
  VALUES ('TEST-F2', v_prov, v_local, 5000, 'pendiente', 'factura', '[]'::jsonb, v_tenant, 'F2', CURRENT_DATE);

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 1 (2 facturas \$10k+\$5k): saldo=%, esperado=15000', v_saldo;
  IF v_saldo <> 15000 THEN RAISE EXCEPTION 'FAIL paso 1: %', v_saldo; END IF;

  -- Paso 2: agregar remito sin facturar
  INSERT INTO remitos (id, prov_id, local_id, monto, estado, factura_id, tenant_id, nro, fecha)
  VALUES ('TEST-R1', v_prov, v_local, 3000, 'sin_factura', NULL, v_tenant, 'R1', CURRENT_DATE);

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 2 (+remito \$3k sin factura): saldo=%, esperado=18000', v_saldo;
  IF v_saldo <> 18000 THEN RAISE EXCEPTION 'FAIL paso 2: %', v_saldo; END IF;

  -- Paso 3: vincular el remito a F1 → debe restar el monto del remito
  UPDATE remitos SET estado='vinculado', factura_id='TEST-F1' WHERE id='TEST-R1';

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 3 (remito vinculado): saldo=%, esperado=15000', v_saldo;
  IF v_saldo <> 15000 THEN RAISE EXCEPTION 'FAIL paso 3: %', v_saldo; END IF;

  -- Paso 4: pago parcial \$2k a F1 simulando lo que hace pagar_factura
  -- (UPDATE pagos JSONB). El test enfoca en los triggers; las RPCs
  -- validan tenant del JWT y eso no aplica desde service_role.
  UPDATE facturas
     SET pagos = '[{"cuenta":"Caja Chica","monto":2000,"fecha":"2026-05-07"}]'::jsonb
   WHERE id = 'TEST-F1';

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 4 (pago parcial \$2k a F1): saldo=%, esperado=13000', v_saldo;
  IF v_saldo <> 13000 THEN RAISE EXCEPTION 'FAIL paso 4: %', v_saldo; END IF;

  -- Paso 5: anular F2 → trigger excluye 'anulada' → resta sus \$5k.
  UPDATE facturas SET estado = 'anulada' WHERE id = 'TEST-F2';

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 5 (anular F2): saldo=%, esperado=8000', v_saldo;
  IF v_saldo <> 8000 THEN RAISE EXCEPTION 'FAIL paso 5: %', v_saldo; END IF;

  -- Paso 6: pagar el resto de F1 (\$8k) → factura queda pagada (total=10k,
  -- pagado=2k+8k=10k) → trigger la excluye → saldo=0.
  UPDATE facturas
     SET pagos = '[{"cuenta":"Caja Chica","monto":2000,"fecha":"2026-05-07"},
                   {"cuenta":"Caja Chica","monto":8000,"fecha":"2026-05-07"}]'::jsonb,
         estado = 'pagada'
   WHERE id = 'TEST-F1';

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 6 (pago final F1): saldo=%, esperado=0', v_saldo;
  IF v_saldo <> 0 THEN RAISE EXCEPTION 'FAIL paso 6: %', v_saldo; END IF;

  -- Paso 7: nota de crédito de \$1k → resta del saldo.
  INSERT INTO facturas (id, prov_id, local_id, total, estado, tipo, pagos, tenant_id, nro, fecha)
  VALUES ('TEST-NC1', v_prov, v_local, 1000, 'pendiente', 'nota_credito', '[]'::jsonb, v_tenant, 'NC1', CURRENT_DATE);

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 7 (NC \$1k): saldo=%, esperado=-1000', v_saldo;
  IF v_saldo <> -1000 THEN RAISE EXCEPTION 'FAIL paso 7: %', v_saldo; END IF;

  -- Paso 8: anular el remito vinculado (debería ser idempotente: ya no
  -- contaba al estar vinculado; al pasar a 'anulado' tampoco cuenta).
  UPDATE remitos SET estado = 'anulado' WHERE id = 'TEST-R1';

  SELECT saldo INTO v_saldo FROM proveedores WHERE id = v_prov;
  RAISE NOTICE 'Paso 8 (anular remito ya vinculado): saldo=%, esperado=-1000', v_saldo;
  IF v_saldo <> -1000 THEN RAISE EXCEPTION 'FAIL paso 8: %', v_saldo; END IF;

  RAISE NOTICE '✓ Todos los pasos del test pasaron';
END$$;

ROLLBACK;
