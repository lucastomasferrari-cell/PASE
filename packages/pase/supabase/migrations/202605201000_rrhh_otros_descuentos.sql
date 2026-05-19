-- ═══════════════════════════════════════════════════════════════════════════
-- RRHH — otros descuentos manuales en novedades
--
-- Pedido Lucas 2026-05-19: en el modal de novedades RRHH se podía cargar
-- inasistencias / horas extras / dobles / adelantos (estos últimos solo
-- lectura desde tab Pagos) pero NO había forma de descontar otros conceptos
-- arbitrarios (préstamos personales, daños, faltantes de caja, gastos
-- personales facturados al empleado, etc).
--
-- 2 columnas nuevas:
--   otros_descuentos: NUMERIC, monto a descontar del total final.
--   otros_descuentos_motivo: TEXT libre con razón (para auditoría).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE rrhh_novedades
  ADD COLUMN IF NOT EXISTS otros_descuentos NUMERIC NOT NULL DEFAULT 0
    CHECK (otros_descuentos >= 0),
  ADD COLUMN IF NOT EXISTS otros_descuentos_motivo TEXT NULL;

COMMENT ON COLUMN rrhh_novedades.otros_descuentos IS
  'Descuentos manuales arbitrarios del sueldo (préstamos, daños, etc). Se restan del total después de adelantos.';
COMMENT ON COLUMN rrhh_novedades.otros_descuentos_motivo IS
  'Motivo del descuento manual. Texto libre para auditoría.';

-- También en liquidaciones para snapshot del valor calculado al confirmar.
ALTER TABLE rrhh_liquidaciones
  ADD COLUMN IF NOT EXISTS otros_descuentos NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN rrhh_liquidaciones.otros_descuentos IS
  'Snapshot del campo otros_descuentos de la novedad al momento de confirmar.';

NOTIFY pgrst, 'reload schema';
