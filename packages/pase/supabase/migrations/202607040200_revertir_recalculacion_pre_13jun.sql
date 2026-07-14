-- REVERT: deshace la migración 202607032500 que recalculó liquidaciones
-- pre-13-jun. Restaura total_a_pagar y desgloses al valor original
-- usando los datos_anteriores guardados en auditoria.

BEGIN;

UPDATE rrhh_liquidaciones l SET
  total_a_pagar       = (a.datos_anteriores->>'total_a_pagar')::numeric,
  sueldo_base         = (a.datos_anteriores->>'sueldo_base')::numeric,
  total_feriados      = (a.datos_anteriores->>'total_feriados')::numeric,
  total_dobles        = (a.datos_anteriores->>'total_dobles')::numeric,
  total_horas_extras  = (a.datos_anteriores->>'total_horas_extras')::numeric,
  monto_presentismo   = (a.datos_anteriores->>'monto_presentismo')::numeric
FROM auditoria a
WHERE a.accion = 'CORRECCION_DESGLOSE_PRE_13JUN'
  AND l.id::text = a.registro_id;

INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, usuario, fecha, detalle, tenant_id)
SELECT
  'rrhh_liquidaciones',
  a.registro_id,
  'REVERT_CORRECCION_PRE_13JUN',
  a.datos_nuevos,
  a.datos_anteriores,
  'migration_202607040200',
  now(),
  'Revert de ' || a.detalle,
  a.tenant_id
FROM auditoria a
WHERE a.accion = 'CORRECCION_DESGLOSE_PRE_13JUN';

COMMIT;
