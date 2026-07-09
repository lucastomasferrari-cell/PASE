-- 202607090100 · Login por local + PIN throttling + min 1 admin por tenant
--
-- Base del modelo PIN-first multi-tenant (SPEC 09-jul-2026).
--
-- Cada local tiene un "login del local" = mail ficticio autogenerado
-- + password aleatoria. La tablet se loguea una vez con eso y queda
-- eternamente logueada. Cada persona se identifica con su PIN de 4 dígitos.
--
-- El PIN de 4 dígitos es 10.000 combos → bloqueamos tras 5 intentos.
--
-- Al eliminar/deactivar el último admin del tenant → bloqueado por trigger.

-- ─── 1. Columnas de login del local ────────────────────────────────────────
ALTER TABLE locales
  ADD COLUMN IF NOT EXISTS login_email text UNIQUE,
  ADD COLUMN IF NOT EXISTS login_password_rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS login_password_rotated_by uuid;

COMMENT ON COLUMN locales.login_email IS
  'Mail ficticio autogenerado para el login del local en COMANDA/MESA. Se autogenera desde Accesos al primer "Ver credenciales".';
COMMENT ON COLUMN locales.login_password_rotated_at IS
  'Cuándo se rotó la contraseña del login del local por última vez.';
COMMENT ON COLUMN locales.login_password_rotated_by IS
  'auth_id del admin que rotó la contraseña por última vez.';

-- Backfill: Devoto ya usa "nekodevoto" desde ayer, dejamos linkeado.
UPDATE locales SET login_email = 'nekodevoto' WHERE id = 3 AND login_email IS NULL;

-- ─── 2. PIN throttling ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pin_intentos_fallidos (
  local_id integer PRIMARY KEY REFERENCES locales(id) ON DELETE CASCADE,
  intentos integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  ultimo_intento_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pin_intentos_fallidos IS
  'Contador de intentos fallidos de PIN por local. Tras 5 intentos → bloquea 5 min.';

CREATE OR REPLACE FUNCTION fn_verificar_pin_pos(p_local_id integer, p_pin text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_bloqueado_hasta timestamptz;
  v_segundos_restantes integer;
BEGIN
  -- ¿Está bloqueado?
  SELECT bloqueado_hasta INTO v_bloqueado_hasta
    FROM pin_intentos_fallidos WHERE local_id = p_local_id;

  IF v_bloqueado_hasta IS NOT NULL AND v_bloqueado_hasta > now() THEN
    v_segundos_restantes := EXTRACT(epoch FROM (v_bloqueado_hasta - now()))::integer;
    RAISE EXCEPTION 'PIN_BLOQUEADO_%', v_segundos_restantes;
  END IF;

  -- Verificar PIN
  SELECT id INTO v_id
    FROM rrhh_empleados
   WHERE local_id = p_local_id
     AND pos_activo = TRUE
     AND activo = TRUE
     AND pin_pos IS NOT NULL
     AND pin_pos = crypt(p_pin, pin_pos)
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Correcto → reset del contador
    INSERT INTO pin_intentos_fallidos (local_id, intentos, bloqueado_hasta, ultimo_intento_at)
    VALUES (p_local_id, 0, NULL, now())
    ON CONFLICT (local_id) DO UPDATE SET
      intentos = 0, bloqueado_hasta = NULL, ultimo_intento_at = now();
    RETURN v_id;
  END IF;

  -- Incorrecto → incrementar. Si llega a 5 → bloquear 5 min y resetear.
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

-- ─── 3. Min 1 admin activo por tenant en comanda_usuarios ──────────────────
CREATE OR REPLACE FUNCTION fn_check_min_admin_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_tenant uuid;
BEGIN
  -- Solo chequear si el cambio ELIMINA un admin activo:
  --   DELETE de admin activo,
  --   UPDATE que cambia rol_pos != admin,
  --   UPDATE que setea activo=false.
  IF (TG_OP = 'DELETE' AND OLD.rol_pos = 'admin' AND OLD.activo = true) OR
     (TG_OP = 'UPDATE' AND OLD.rol_pos = 'admin' AND OLD.activo = true AND
       (NEW.rol_pos <> 'admin' OR NEW.activo = false))
  THEN
    v_tenant := OLD.tenant_id;
    SELECT COUNT(*) INTO v_count
      FROM comanda_usuarios
     WHERE tenant_id = v_tenant
       AND rol_pos = 'admin'
       AND activo = true
       AND id <> OLD.id;

    IF v_count < 1 THEN
      RAISE EXCEPTION 'MIN_ADMIN_TENANT: cada tenant necesita al menos 1 admin activo (agregá otro antes de sacar este)';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_min_admin_tenant ON comanda_usuarios;
CREATE TRIGGER trg_check_min_admin_tenant
BEFORE DELETE OR UPDATE ON comanda_usuarios
FOR EACH ROW EXECUTE FUNCTION fn_check_min_admin_tenant();
