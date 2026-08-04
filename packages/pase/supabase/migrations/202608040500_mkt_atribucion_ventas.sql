-- Atribución de ventas a campañas de email (Habitué marketing)
-- ---------------------------------------------------------------------------
-- "¿Cuánto vendí gracias a esta campaña?" — como Mailchimp. Cuenta las ventas
-- POS (ventas_pos) de contactos que RECIBIERON la campaña, hechas dentro de una
-- ventana de X días desde el envío. Excluye anuladas y abiertas. Match por
-- cliente_id o, si falta, por email. Devuelve compradores / nº ventas / ingresos.
-- Solo agregados (no filas) → seguro; igual valida tenant del que consulta.

CREATE OR REPLACE FUNCTION public.fn_mkt_atribucion_ventas(
  p_campana_id uuid, p_dias integer DEFAULT 7
) RETURNS TABLE(compradores integer, ventas integer, ingresos numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_desde  timestamptz;
BEGIN
  SELECT tenant_id, enviada_at INTO v_tenant, v_desde FROM mkt_campanas WHERE id = p_campana_id;
  IF v_tenant IS NULL OR v_desde IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0::numeric;
    RETURN;
  END IF;
  IF auth_tenant_id() IS NOT NULL AND auth_tenant_id() <> v_tenant THEN
    RAISE EXCEPTION 'TENANT_MISMATCH';
  END IF;

  RETURN QUERY
  SELECT count(DISTINCT v.cliente_id)::int,
         count(*)::int,
         COALESCE(sum(v.total), 0)::numeric
    FROM ventas_pos v
   WHERE v.tenant_id = v_tenant
     AND v.estado NOT IN ('anulada', 'abierta')
     AND v.created_at >= v_desde
     AND v.created_at <  v_desde + (p_dias || ' days')::interval
     AND EXISTS (
       SELECT 1 FROM mkt_campana_destinatarios d
        WHERE d.campana_id = p_campana_id
          AND (d.cliente_id = v.cliente_id
               OR (v.cliente_email IS NOT NULL AND lower(d.email) = lower(v.cliente_email)))
     );
END;
$function$;
