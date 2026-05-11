-- Catch-up retroactivo: las columnas `monto_pagado` y `pendiente` ya existen
-- en la DB real (`rrhh_pagos_especiales`) pero nunca fueron commiteadas
-- como migration. Las RPCs `pagar_vacaciones` y `pagar_aguinaldo`
-- (mig 20260423_rpc_pagos_atomicos.sql:574,648) las usan en sus INSERT.
--
-- Sin esta migration, si alguna vez se recrea la DB desde cero, las
-- RPCs van a fallar con `column "monto_pagado" of relation
-- "rrhh_pagos_especiales" does not exist`. Esta migration garantiza
-- que el repo y la DB queden alineados.
--
-- Idempotente: IF NOT EXISTS no toca nada si las columnas ya existen.
-- Verificado en prod 2026-05-11: ambas columnas ya están con datos OK.

ALTER TABLE rrhh_pagos_especiales
  ADD COLUMN IF NOT EXISTS monto_pagado numeric;

ALTER TABLE rrhh_pagos_especiales
  ADD COLUMN IF NOT EXISTS pendiente boolean DEFAULT false;
