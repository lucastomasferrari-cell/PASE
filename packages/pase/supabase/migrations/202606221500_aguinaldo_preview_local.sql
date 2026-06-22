-- 202606221500_aguinaldo_preview_local.sql
-- Preview para el pago masivo de aguinaldos: por cada empleado ACTIVO del local,
-- devuelve el MEJOR mes del semestre (mayor bruto = subtotal2, sumando las cuotas
-- del mes) + su desglose. El front calcula el aguinaldo = bruto/2 * proporción.
-- Solo lectura (no mueve plata). SECURITY DEFINER con chequeo de auth (C11).
CREATE OR REPLACE FUNCTION aguinaldo_preview_local(p_local_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_res jsonb;
  v_anio int;
  v_mes int;
  v_mi int;
  v_mf int;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() AND NOT (p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO';
  END IF;

  v_anio := EXTRACT(year  FROM (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int;
  v_mes  := EXTRACT(month FROM (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int;
  IF v_mes <= 6 THEN v_mi := 1; v_mf := 6; ELSE v_mi := 7; v_mf := 12; END IF;

  WITH por_mes AS (
    SELECT n.empleado_id, n.mes,
      SUM(l.sueldo_base)         AS sueldo_base,
      SUM(l.monto_presentismo)   AS presentismo,
      SUM(l.total_horas_extras)  AS horas_extras,
      SUM(l.total_dobles)        AS dobles,
      SUM(l.total_feriados)      AS feriados,
      SUM(l.total_vacaciones)    AS vacaciones,
      SUM(l.bono)                AS bono,
      SUM(l.descuento_ausencias) AS ausencias,
      SUM(l.subtotal2)           AS bruto
    FROM rrhh_liquidaciones l
    JOIN rrhh_novedades n  ON n.id = l.novedad_id
    JOIN rrhh_empleados e  ON e.id = n.empleado_id
    WHERE e.tenant_id = v_tenant AND e.local_id = p_local_id AND e.activo
      AND l.anulado = false AND n.anio = v_anio AND n.mes BETWEEN v_mi AND v_mf
    GROUP BY n.empleado_id, n.mes
  ),
  mejor AS (
    SELECT DISTINCT ON (empleado_id) *
    FROM por_mes
    ORDER BY empleado_id, bruto DESC NULLS LAST, mes DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'empleado_id',   e.id,
    'apellido',      e.apellido,
    'nombre',        e.nombre,
    'puesto',        e.puesto,
    'fecha_inicio',  e.fecha_inicio,
    'sueldo_mensual', e.sueldo_mensual,
    'mejor_mes',     m.mes,
    'bruto',         COALESCE(m.bruto, 0),
    'desglose', CASE WHEN m.mes IS NULL THEN NULL ELSE jsonb_build_object(
      'sueldo_base',  m.sueldo_base,
      'presentismo',  m.presentismo,
      'horas_extras', m.horas_extras,
      'dobles',       m.dobles,
      'feriados',     m.feriados,
      'vacaciones',   m.vacaciones,
      'bono',         m.bono,
      'ausencias',    m.ausencias
    ) END
  ) ORDER BY e.apellido), '[]'::jsonb)
  INTO v_res
  FROM rrhh_empleados e
  LEFT JOIN mejor m ON m.empleado_id = e.id
  WHERE e.tenant_id = v_tenant AND e.local_id = p_local_id AND e.activo;

  RETURN v_res;
END
$function$;

NOTIFY pgrst, 'reload schema';
