-- 202606212330_revert_reclasificar_compra_online.sql
-- REVIERTE 202606211500. Lucas (22-jun) confirmó que COMPRA ONLINE y COMPRA
-- MERCADO LIBRE son RETIROS DE SOCIOS (compras personales pagadas por el
-- negocio), no gasto operativo del local. Vuelven a tipo=retiro_socio → van
-- DEBAJO de la utilidad neta (distribución), dejan de restar del resultado.
--
-- Dos namespaces de `tipo`:
--   config_categorias.tipo usa forma larga -> 'retiro_socio'
--   gastos.tipo            usa forma corta -> 'retiro_socio' (acá coinciden)
--
-- NO toca 'COMPRAS MERCADO LIBRE' (plural) — esa es una categoría real de gasto
-- variable distinta. Solo cambia clasificación; no toca montos, fechas ni caja.
-- Filtrado por tenant (Neko) para no afectar otros tenants. Idempotente.
UPDATE config_categorias
   SET tipo = 'retiro_socio'
 WHERE tenant_id = '5841143c-5594-4728-99c6-a313d40618e6'
   AND nombre IN ('COMPRA ONLINE', 'COMPRA MERCADO LIBRE')
   AND tipo = 'gasto_variable';

UPDATE gastos
   SET tipo = 'retiro_socio'
 WHERE tenant_id = '5841143c-5594-4728-99c6-a313d40618e6'
   AND categoria IN ('COMPRA ONLINE', 'COMPRA MERCADO LIBRE')
   AND tipo = 'variable';
