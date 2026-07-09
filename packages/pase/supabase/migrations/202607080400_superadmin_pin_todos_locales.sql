-- 202607080400 · PIN superadmin para todos los locales
--
-- Lucas 2026-07-08: PIN único para poder anular en cualquier local sin
-- depender del staff local. Se crea un empleado "Superadmin" con
-- rol_pos='dueno' en cada local con el mismo PIN.
--
-- PIN: 4826 (random 4 dígitos). Rol 'dueno' = todos los overrides
-- (anular venta, item, cambiar precio, descuento >15%, etc).

DO $$
DECLARE
  v_pin text := '4826';
  v_local record;
  v_existing uuid;
  v_new_id uuid;
BEGIN
  FOR v_local IN
    SELECT l.id, l.nombre, l.tenant_id
      FROM locales l
     WHERE l.tenant_id IS NOT NULL
  LOOP
    -- ¿ya existe un Superadmin en este local?
    SELECT id INTO v_existing
      FROM rrhh_empleados
     WHERE local_id = v_local.id
       AND nombre = 'Superadmin'
       AND apellido = '-'
     LIMIT 1;

    IF v_existing IS NOT NULL THEN
      UPDATE rrhh_empleados
         SET rol_pos = 'dueno',
             activo = true,
             pos_activo = true,
             pin_pos = crypt(v_pin, gen_salt('bf')),
             pin_actualizado_at = NOW()
       WHERE id = v_existing;
      RAISE NOTICE 'Local % (%): superadmin ya existía → PIN reseteado', v_local.id, v_local.nombre;
    ELSE
      INSERT INTO rrhh_empleados (
        tenant_id, local_id, apellido, nombre, puesto, sueldo_mensual,
        activo, rol_pos, pos_activo, pin_pos, pin_actualizado_at
      ) VALUES (
        v_local.tenant_id, v_local.id, '-', 'Superadmin', 'Superadmin', 0,
        true, 'dueno', true, crypt(v_pin, gen_salt('bf')), NOW()
      ) RETURNING id INTO v_new_id;
      RAISE NOTICE 'Local % (%): superadmin creado id=%', v_local.id, v_local.nombre, v_new_id;
    END IF;
  END LOOP;
END $$;

-- Verificación
SELECT l.id AS local_id, l.nombre AS local, e.rol_pos, e.activo, e.pos_activo,
       (e.pin_pos IS NOT NULL) AS tiene_pin
  FROM rrhh_empleados e
  JOIN locales l ON l.id = e.local_id
 WHERE e.nombre = 'Superadmin' AND e.apellido = '-'
 ORDER BY l.id;
