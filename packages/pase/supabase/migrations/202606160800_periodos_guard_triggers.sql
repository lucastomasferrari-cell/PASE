-- 202606160800_periodos_guard_triggers.sql
-- Bloquea crear/editar/anular datos con fecha en un mes cerrado.
-- Bypass: reusa el GUC pase.skip_orphan_guard (eliminar_tenant_completo ya lo
-- setea → cubre borrado de tenant y teardown de tests sin tocar esa función).
BEGIN;

-- Guard genérico para tablas con local_id + fecha (ventas, facturas, remitos, gastos, movimientos).
CREATE OR REPLACE FUNCTION fn_guard_periodo_cerrado()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_j jsonb; v_local int; v_fecha date;
BEGIN
  IF current_setting('pase.skip_orphan_guard', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_j := to_jsonb(NEW);
    v_local := NULLIF(v_j->>'local_id','')::int;
    v_fecha := NULLIF(v_j->>'fecha','')::date;
    IF v_local IS NOT NULL AND v_fecha IS NOT NULL AND fn_periodo_esta_cerrado(v_local, v_fecha) THEN
      RAISE EXCEPTION 'PERIODO_CERRADO' USING DETAIL =
        format('%s con fecha %s cae en un mes cerrado (local %s).', TG_TABLE_NAME, v_fecha, v_local);
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_j := to_jsonb(OLD);
    v_local := NULLIF(v_j->>'local_id','')::int;
    v_fecha := NULLIF(v_j->>'fecha','')::date;
    IF v_local IS NOT NULL AND v_fecha IS NOT NULL AND fn_periodo_esta_cerrado(v_local, v_fecha) THEN
      RAISE EXCEPTION 'PERIODO_CERRADO' USING DETAIL =
        format('%s con fecha %s cae en un mes cerrado (local %s).', TG_TABLE_NAME, v_fecha, v_local);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- Guard específico para rrhh_liquidaciones (sin fecha/local_id directos):
-- resuelve por la novedad (mes/anio) + el empleado (local_id).
CREATE OR REPLACE FUNCTION fn_guard_periodo_cerrado_liquidacion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rec rrhh_liquidaciones; v_local int; v_fecha date;
BEGIN
  IF current_setting('pase.skip_orphan_guard', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  v_rec := COALESCE(NEW, OLD);
  SELECT emp.local_id, make_date(nov.anio, nov.mes, 1)
    INTO v_local, v_fecha
  FROM rrhh_novedades nov JOIN rrhh_empleados emp ON emp.id = nov.empleado_id
  WHERE nov.id = v_rec.novedad_id;
  IF v_local IS NOT NULL AND v_fecha IS NOT NULL AND fn_periodo_esta_cerrado(v_local, v_fecha) THEN
    RAISE EXCEPTION 'PERIODO_CERRADO' USING DETAIL =
      format('Sueldo de un mes cerrado (local %s, %s).', v_local, v_fecha);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- Triggers en las 5 tablas con fecha+local_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ventas','facturas','remitos','gastos','movimientos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_periodo_cerrado ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_periodo_cerrado BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fn_guard_periodo_cerrado()', t);
  END LOOP;
END $$;

-- Trigger en rrhh_liquidaciones.
DROP TRIGGER IF EXISTS trg_periodo_cerrado_liq ON rrhh_liquidaciones;
CREATE TRIGGER trg_periodo_cerrado_liq BEFORE INSERT OR UPDATE OR DELETE ON rrhh_liquidaciones
  FOR EACH ROW EXECUTE FUNCTION fn_guard_periodo_cerrado_liquidacion();

COMMIT;
