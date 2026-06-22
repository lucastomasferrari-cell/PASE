-- 202606211500_reclasificar_compra_online.sql
-- Reclasifica "COMPRA ONLINE" y "COMPRA MERCADO LIBRE" de retiro_socio a GASTO
-- VARIABLE. Estaban mal clasificadas como "retiro de socio": son compras reales
-- del negocio, pero al ser tipo=retiro_socio iban DESPUÉS de la utilidad neta y
-- NO restaban de la ganancia → utilidad inflada. Aprobado por Lucas (21-jun).
--
-- OJO con los dos namespaces de `tipo`:
--   config_categorias.tipo usa forma larga  -> 'gasto_variable'
--   gastos.tipo            usa forma corta   -> 'variable'
--
-- Solo cambia la CLASIFICACIÓN contable (afecta EERR/cashflow por tipo). NO toca
-- montos, fechas ni los movimientos de caja (la plata ya salió). "RETIRO EFECTIVO"
-- se deja como está: el EERR ya lo ignora (solo cuenta categoría 'Retiro socio').
-- Idempotente: re-correr no hace nada (ya no quedan filas con tipo viejo).
BEGIN;

UPDATE config_categorias
   SET tipo = 'gasto_variable'
 WHERE nombre IN ('COMPRA ONLINE', 'COMPRA MERCADO LIBRE')
   AND tipo = 'retiro_socio';

UPDATE gastos
   SET tipo = 'variable'
 WHERE categoria IN ('COMPRA ONLINE', 'COMPRA MERCADO LIBRE')
   AND tipo = 'retiro_socio';

COMMIT;
