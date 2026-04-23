-- Cuentas de Tesorería que un usuario puede ver/operar.
-- NULL    → todas las cuentas (backwards-compat con usuarios viejos y dueno/admin).
-- text[]  → sólo las cuentas listadas. Array vacío = ninguna.
-- Valores posibles: los de CUENTAS en src/lib/constants.ts
-- (Caja Chica, Caja Mayor, Caja Efectivo, MercadoPago, Banco).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cuentas_visibles text[] DEFAULT NULL;
COMMENT ON COLUMN usuarios.cuentas_visibles IS
  'NULL = todas las cuentas; array = filtro estricto; array vacío = ninguna';
