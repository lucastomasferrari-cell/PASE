-- ═══════════════════════════════════════════════════════════════════════════
-- Empleados — días de vacaciones ya tomados al alta + flag "registrado"
-- Sesión 2026-05-17
--
-- Lucas reportó 2 problemas en la pantalla de Equipo:
--
-- 1) Bug lógico en cálculo de vacaciones: cuando se carga un empleado con
--    fecha de ingreso vieja (ej. 3 años atrás), el sistema acumula TODOS
--    los días de vacaciones por antigüedad asumiendo que nunca se tomaron.
--    Eso es falso para empleados que ya trabajaban antes de adoptar PASE.
--    Solución: campo opcional `dias_vacaciones_ya_tomados_al_alta` que
--    representa cuántos días ya consumió antes de estar en el sistema.
--    El cálculo nuevo resta esta cantidad al total por antigüedad.
--
-- 2) Falta saber qué empleados están "en blanco" (no registrados/no en
--    nómina formal). Campo `registrado` boolean default FALSE → en la
--    tabla aparece un chip "Sí/No" + contador "X sin registrar" arriba
--    para que el dueño pueda hacer foco en regularizar.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE rrhh_empleados
  ADD COLUMN IF NOT EXISTS dias_vacaciones_ya_tomados_al_alta INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS registrado BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN rrhh_empleados.dias_vacaciones_ya_tomados_al_alta IS
  'Días de vacaciones que el empleado ya consumió ANTES de cargarlo en PASE. Se restan al cálculo automático por antigüedad. Default 0 (asume que es nuevo o nunca tomó).';

COMMENT ON COLUMN rrhh_empleados.registrado IS
  'TRUE si el empleado está en nómina formal (registrado ante AFIP). Default FALSE. Sirve para que el dueño tenga visibilidad de cuántos empleados sigue "en blanco" y cuántos no.';

NOTIFY pgrst, 'reload schema';
