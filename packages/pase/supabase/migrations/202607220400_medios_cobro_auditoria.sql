-- AUDITORÍA de medios_cobro
-- ═════════════════════════════════════════════════════════════════════════
-- Disparador: el 22-jul se apagaron 13 medios (activo=false) desde Ajustes y
-- no hubo forma de saber quién/cómo — medios_cobro no estaba auditada. Rompió
-- el import de cierre de 4 locales (Maneki, Villa Crespo, Rene, Belgrano).
-- Este trigger registra alta/cambio/baja en la tabla `auditoria`, capturando
-- QUIÉN (usuario del JWT) y un detalle legible cuando cambia `activo`.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_medios_cobro_audit()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    int := auth_usuario_id();
  v_uname  text;
  v_reg    text;
  v_tenant uuid;
  v_detalle text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_reg := OLD.id::text; v_tenant := OLD.tenant_id;
  ELSE
    v_reg := NEW.id::text; v_tenant := NEW.tenant_id;
  END IF;

  SELECT nombre INTO v_uname FROM usuarios WHERE id = v_uid;

  IF TG_OP = 'UPDATE' AND OLD.activo IS DISTINCT FROM NEW.activo THEN
    v_detalle := format('activo: %s → %s  (medio "%s", local %s)', OLD.activo, NEW.activo, NEW.nombre, NEW.local_id);
  ELSIF TG_OP = 'UPDATE' THEN
    v_detalle := format('edición medio "%s"', NEW.nombre);
  ELSIF TG_OP = 'INSERT' THEN
    v_detalle := format('alta medio "%s"', NEW.nombre);
  ELSE
    v_detalle := format('DELETE físico medio "%s"', OLD.nombre);
  END IF;

  INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, usuario, fecha, detalle, tenant_id)
  VALUES (
    'medios_cobro', v_reg, TG_OP,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('UPDATE','INSERT') THEN to_jsonb(NEW) END,
    COALESCE(v_uid::text || COALESCE(' — ' || v_uname, ''), 'sistema/DB directo'),
    now(), v_detalle, v_tenant
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $fn$;

DROP TRIGGER IF EXISTS trg_medios_cobro_audit ON public.medios_cobro;
CREATE TRIGGER trg_medios_cobro_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.medios_cobro
  FOR EACH ROW EXECUTE FUNCTION fn_medios_cobro_audit();
