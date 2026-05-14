-- ═══════════════════════════════════════════════════════════════════════════
-- BUGFIX CRÍTICO: rrhh_pagos_especiales.id de INTEGER → UUID
--
-- Fecha:    2026-05-14
-- Detectado por: test mutante liquidacion_final_mutante.spec.ts (auditoría
--                2026-05-14).
--
-- Causa raíz: la RPC liquidacion_final_empleado (migration 202604281206:606)
-- hace `v_pago_id := gen_random_uuid()` y luego `INSERT INTO
-- rrhh_pagos_especiales (id, ...) VALUES (v_pago_id, ...)`. Pero la columna
-- id es INTEGER (auto-increment con sequence). El INSERT siempre fallaba
-- con "column 'id' is of type integer but expression is of type uuid".
--
-- Impacto: la RPC liquidacion_final_empleado NUNCA pudo ejecutarse
-- exitosamente desde que existe. En prod, rrhh_pagos_especiales tiene 0
-- filas — confirmado.
--
-- Consistencia: las demás tablas relacionadas usan uuid
--   (rrhh_empleados.id, rrhh_novedades.id, rrhh_liquidaciones.id,
--    rrhh_adelantos.id). El FK movimientos.pago_especial_id_ref ya es uuid.
--   Esta columna era el único integer del set — corregimos.
--
-- Tabla vacía, migración trivial: drop default + drop sequence + cambio tipo.
-- ═══════════════════════════════════════════════════════════════════════════

-- Pre-verificación: si la tabla TIENE filas, abortar (no perder datos).
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM rrhh_pagos_especiales;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'rrhh_pagos_especiales tiene % filas — la migración a UUID requeriría plan de datos. Abortando.', v_count;
  END IF;
END $$;

-- Drop default (sequence) y la sequence misma.
ALTER TABLE rrhh_pagos_especiales ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS rrhh_pagos_especiales_id_seq;

-- Cambiar tipo a uuid. USING expresión: como la tabla está vacía, no hay
-- filas a convertir; pero PostgreSQL requiere la cláusula USING aunque sea
-- vacía conceptualmente.
ALTER TABLE rrhh_pagos_especiales ALTER COLUMN id TYPE uuid USING gen_random_uuid();

-- Nuevo default: gen_random_uuid() (consistente con resto del schema).
ALTER TABLE rrhh_pagos_especiales ALTER COLUMN id SET DEFAULT gen_random_uuid();
