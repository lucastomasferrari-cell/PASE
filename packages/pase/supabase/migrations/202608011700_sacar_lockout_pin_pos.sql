-- Sacar el bloqueo por intentos fallidos del PIN del POS (01-ago, pedido de Lucas)
-- ---------------------------------------------------------------------------
-- El lockout era POR LOCAL (5 PINs fallidos → bloqueaba TODO el local 5 min,
-- para todos). Eso trababa a cajeros con el PIN correcto por culpa de otro que
-- tipeó mal (incidente Devoto 01-ago). Lucas pidió sacarlo.
--
-- Efecto colateral bueno: la tabla pin_intentos_fallidos (que quedó escribible
-- por anon — hallazgo de la auditoría de hoy) deja de usarse, así que ese
-- vector de "resetear el lockout" también desaparece.
--
-- fn_verificar_pin_pos ahora solo valida el PIN y devuelve el empleado (o NULL).

CREATE OR REPLACE FUNCTION public.fn_verificar_pin_pos(p_local_id integer, p_pin text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM rrhh_empleados
   WHERE local_id = p_local_id
     AND pos_activo = TRUE
     AND activo = TRUE
     AND pin_pos IS NOT NULL
     AND pin_pos = crypt(p_pin, pin_pos)
   LIMIT 1;

  RETURN v_id;  -- NULL si no matchea. Sin bloqueo por intentos.
END;
$function$;
