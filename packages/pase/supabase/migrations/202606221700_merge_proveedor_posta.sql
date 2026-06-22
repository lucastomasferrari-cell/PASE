-- 202606221700_merge_proveedor_posta.sql
-- Lucas 22-jun: "POSTA" (id 119) y "POSTA EXPRESS SRL" (id 81) son el MISMO
-- proveedor cargado dos veces. La conciliación no cruzaba porque la
-- transferencia del banco ("Posta Express Srl") se asociaba a 81 y las facturas
-- estaban cargadas contra 119. Se unifica TODO en POSTA EXPRESS SRL (id 81) y se
-- borra POSTA (id 119). Solo tenant Neko.
--
-- Referencias de 119 (verificadas): facturas 39, remitos 1, conciliacion_alias 8.
-- (materias_primas, compras_mapeo, proveedor_saldo_movimientos = 0).
UPDATE facturas SET prov_id = 81
  WHERE prov_id = 119 AND tenant_id = '5841143c-5594-4728-99c6-a313d40618e6';

UPDATE remitos SET prov_id = 81
  WHERE prov_id = 119 AND tenant_id = '5841143c-5594-4728-99c6-a313d40618e6';

-- Aliases de 119 que NO colisionan con uno existente de 81 (mismo titular+local)
-- → reasignar a 81. Los que colisionen se borran al eliminar 119 (FK CASCADE).
UPDATE conciliacion_alias a SET prov_id = 81
  WHERE a.prov_id = 119
    AND NOT EXISTS (
      SELECT 1 FROM conciliacion_alias b
      WHERE b.tenant_id = a.tenant_id
        AND b.titular = a.titular
        AND b.local_id IS NOT DISTINCT FROM a.local_id
        AND b.prov_id <> 119);

-- Borra el proveedor duplicado (CASCADE limpia los aliases de 119 que quedaron).
DELETE FROM proveedores
  WHERE id = 119 AND tenant_id = '5841143c-5594-4728-99c6-a313d40618e6';

-- Recalcula el saldo del proveedor unificado desde sus facturas (ahora todas).
SELECT _recompute_saldo_proveedor(81);
