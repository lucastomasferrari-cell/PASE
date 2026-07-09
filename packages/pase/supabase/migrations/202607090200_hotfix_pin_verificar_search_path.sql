-- 202607090200 · HOTFIX: fn_verificar_pin_pos con search_path que incluye extensions
--
-- La versión de 202607090100 rompió el PIN porque `SET search_path = public`
-- excluye el schema `extensions` donde vive crypt(). Error visible: "function
-- crypt(text, text) does not exist". Lo mismo aplica a la del anterior + demás
-- RPCs que llamen crypt.

CREATE OR REPLACE FUNCTION fn_verificar_pin_pos(p_local_id integer, p_pin text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id uuid;
  v_bloqueado_hasta timestamptz;
  v_segundos_restantes integer;
BEGIN
  SELECT bloqueado_hasta INTO v_bloqueado_hasta
    FROM pin_intentos_fallidos WHERE local_id = p_local_id;

  IF v_bloqueado_hasta IS NOT NULL AND v_bloqueado_hasta > now() THEN
    v_segundos_restantes := EXTRACT(epoch FROM (v_bloqueado_hasta - now()))::integer;
    RAISE EXCEPTION 'PIN_BLOQUEADO_%', v_segundos_restantes;
  END IF;

  SELECT id INTO v_id
    FROM rrhh_empleados
   WHERE local_id = p_local_id
     AND pos_activo = TRUE
     AND activo = TRUE
     AND pin_pos IS NOT NULL
     AND pin_pos = crypt(p_pin, pin_pos)
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    INSERT INTO pin_intentos_fallidos (local_id, intentos, bloqueado_hasta, ultimo_intento_at)
    VALUES (p_local_id, 0, NULL, now())
    ON CONFLICT (local_id) DO UPDATE SET
      intentos = 0, bloqueado_hasta = NULL, ultimo_intento_at = now();
    RETURN v_id;
  END IF;

  INSERT INTO pin_intentos_fallidos (local_id, intentos, bloqueado_hasta, ultimo_intento_at)
  VALUES (p_local_id, 1, NULL, now())
  ON CONFLICT (local_id) DO UPDATE SET
    intentos = CASE
      WHEN pin_intentos_fallidos.intentos + 1 >= 5 THEN 0
      ELSE pin_intentos_fallidos.intentos + 1
    END,
    bloqueado_hasta = CASE
      WHEN pin_intentos_fallidos.intentos + 1 >= 5 THEN now() + INTERVAL '5 minutes'
      ELSE pin_intentos_fallidos.bloqueado_hasta
    END,
    ultimo_intento_at = now();

  RETURN NULL;
END;
$$;
