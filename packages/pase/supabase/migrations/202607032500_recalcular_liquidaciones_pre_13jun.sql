-- Corrección masiva: recalcular el desglose de liquidaciones creadas antes
-- del 13-jun (cuando se agregó la validación server-side). El frontend viejo
-- mandaba p_calc sin validar → feriados/presentismo en Q1 quincenal, dobles
-- guardados como feriados, horas extras negativas fantasma, etc.
--
-- SOLO corrige las columnas de desglose (snapshot) y total_a_pagar.
-- NO toca pagos_realizados ni estado (reflejan plata que ya salió).
-- Audita cada cambio con el delta.

BEGIN;

-- Tabla temporal con el antes/después
CREATE TEMP TABLE _liq_recalc ON COMMIT DROP AS
SELECT
  l.id as liq_id,
  l.novedad_id,
  l.total_a_pagar         as old_total,
  l.sueldo_base           as old_sueldo_base,
  l.descuento_ausencias   as old_desc_aus,
  l.total_horas_extras    as old_hextras,
  l.total_dobles          as old_dobles,
  l.total_feriados        as old_feriados,
  l.total_vacaciones      as old_vac,
  l.subtotal1             as old_sub1,
  l.monto_presentismo     as old_present,
  l.subtotal2             as old_sub2,
  l.adelantos             as old_adel,
  l.bono                  as old_bono,
  l.pagos_realizados,
  l.estado,
  e.apellido, e.nombre, n.cuota_num,
  -- Adelantos que fueron consumidos por esta liquidación
  COALESCE(ARRAY(
    SELECT a.id FROM rrhh_adelantos a
    WHERE a.liquidacion_consumidora_id = l.id
  ), ARRAY[]::uuid[]) as adel_ids,
  fn_liquidacion_total_canonico(
    l.novedad_id,
    COALESCE(ARRAY(
      SELECT a.id FROM rrhh_adelantos a
      WHERE a.liquidacion_consumidora_id = l.id
    ), ARRAY[]::uuid[])
  ) as canon
FROM rrhh_liquidaciones l
JOIN rrhh_novedades n ON n.id = l.novedad_id
JOIN rrhh_empleados e ON e.id = n.empleado_id
WHERE l.calculado_at < '2026-06-13'
  AND l.anulado IS NOT TRUE
  AND e.apellido NOT LIKE '__E2E%'
  AND abs(l.total_a_pagar - (
        fn_liquidacion_total_canonico(
          l.novedad_id,
          COALESCE(ARRAY(
            SELECT a.id FROM rrhh_adelantos a
            WHERE a.liquidacion_consumidora_id = l.id
          ), ARRAY[]::uuid[])
        )->>'total_a_pagar'
      )::numeric) > 1;

-- Aplicar las correcciones
UPDATE rrhh_liquidaciones l SET
  sueldo_base         = (r.canon->>'sueldo_base')::numeric,
  descuento_ausencias = (r.canon->>'descuento_ausencias')::numeric,
  total_horas_extras  = (r.canon->>'total_horas_extras')::numeric,
  total_dobles        = (r.canon->>'total_dobles')::numeric,
  total_feriados      = (r.canon->>'total_feriados')::numeric,
  total_vacaciones    = COALESCE((r.canon->>'total_vacaciones')::numeric, 0),
  subtotal1           = (r.canon->>'subtotal1')::numeric,
  monto_presentismo   = (r.canon->>'monto_presentismo')::numeric,
  subtotal2           = (r.canon->>'subtotal2')::numeric,
  adelantos           = COALESCE((r.canon->>'adelantos')::numeric, 0),
  bono                = COALESCE((r.canon->>'bono')::numeric, 0),
  total_a_pagar       = (r.canon->>'total_a_pagar')::numeric
FROM _liq_recalc r
WHERE l.id = r.liq_id;

-- Auditar cada corrección
INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, usuario, fecha, detalle, tenant_id)
SELECT
  'rrhh_liquidaciones',
  r.liq_id::text,
  'CORRECCION_DESGLOSE_PRE_13JUN',
  jsonb_build_object(
    'total_a_pagar', r.old_total,
    'sueldo_base', r.old_sueldo_base,
    'total_feriados', r.old_feriados,
    'total_dobles', r.old_dobles,
    'total_horas_extras', r.old_hextras,
    'monto_presentismo', r.old_present
  ),
  jsonb_build_object(
    'total_a_pagar', (r.canon->>'total_a_pagar')::numeric,
    'sueldo_base', (r.canon->>'sueldo_base')::numeric,
    'total_feriados', (r.canon->>'total_feriados')::numeric,
    'total_dobles', (r.canon->>'total_dobles')::numeric,
    'total_horas_extras', (r.canon->>'total_horas_extras')::numeric,
    'monto_presentismo', (r.canon->>'monto_presentismo')::numeric,
    'diff', r.old_total - (r.canon->>'total_a_pagar')::numeric,
    'pagos_realizados', r.pagos_realizados,
    'sobrepago', GREATEST(0, r.pagos_realizados - (r.canon->>'total_a_pagar')::numeric)
  ),
  'migration_202607032500',
  now(),
  r.apellido || ' ' || r.nombre || ' Q' || r.cuota_num
    || ' | total ' || r.old_total || '->' || (r.canon->>'total_a_pagar')::numeric
    || ' | sobrepago $' || GREATEST(0, r.pagos_realizados - (r.canon->>'total_a_pagar')::numeric),
  (SELECT tenant_id FROM rrhh_liquidaciones WHERE id = r.liq_id)
FROM _liq_recalc r;

COMMIT;
