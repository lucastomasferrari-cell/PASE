-- Hacer `remitos.prov_id` opcional (NULL-able).
--
-- Por qué: Lucas pidió que el proveedor sea opcional al cargar un remito
-- (compras informales donde no se quiere asignar proveedor, o pequeñas
-- compras sin identificar). El frontend ya manda `null` cuando no se
-- selecciona proveedor (Compras.tsx::guardarRemito).
--
-- Idempotente: si la columna ya es nullable, ALTER no hace nada. Si era
-- NOT NULL, ahora acepta NULL. Sin riesgo de pérdida de datos — solo
-- afloja una restricción.
--
-- RPC `pagar_remito` (migration 202604281206:295-307) ya maneja prov_id
-- NULL: solo actualiza `proveedores.saldo` si `r.prov_id IS NOT NULL`.

ALTER TABLE remitos ALTER COLUMN prov_id DROP NOT NULL;
