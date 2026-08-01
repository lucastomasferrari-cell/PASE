-- PIN del POS respeta las cesiones de empleados (01-ago)
-- ---------------------------------------------------------------------------
-- Problema (Camilo): un empleado cesionado (rrhh_empleado_locales) a otro local
-- no podía entrar con su PIN en el local al que está cedido, porque
-- fn_verificar_pin_pos solo miraba `local_id = p_local_id` (el local de origen
-- de la ficha) e ignoraba las cesiones. Su ficha real (Belgrano) tenía el PIN,
-- pero al validar en Devoto no se la consideraba.
--
-- Fix: la validación ahora matchea empleados cuyo PIN coincide Y que están
-- basados en ese local O cedidos a ese local (cesión activa). Sirve para
-- cualquier cesionado. (El lockout ya se sacó en 202608011700.)

CREATE OR REPLACE FUNCTION public.fn_verificar_pin_pos(p_local_id integer, p_pin text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  SELECT e.id INTO v_id
    FROM rrhh_empleados e
   WHERE e.pos_activo = TRUE
     AND e.activo = TRUE
     AND e.pin_pos IS NOT NULL
     AND e.pin_pos = crypt(p_pin, e.pin_pos)
     AND (
       e.local_id = p_local_id
       OR EXISTS (
         SELECT 1 FROM rrhh_empleado_locales el
          WHERE el.empleado_id = e.id
            AND el.local_id = p_local_id
            AND el.deleted_at IS NULL
            AND (el.fecha_hasta IS NULL OR el.fecha_hasta >= current_date)
       )
     )
   LIMIT 1;

  RETURN v_id;  -- NULL si no matchea.
END;
$function$;
