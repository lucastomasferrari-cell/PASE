-- ═══════════════════════════════════════════════════════════════════════════
-- Migrar columnas registrado_por/subido_por/pagado_por TEXT → INTEGER + FK.
--
-- Bug encontrado durante A-4 de la auditoría 2026-05-12: la migration
-- original 20260414_rrhh_legajo.sql definió las 3 columnas como TEXT con
-- comentario "REFERENCES usuarios(id)" pero al ser TEXT, NO se creó la FK.
-- Resultado: pueden contener cualquier string, sin validación de que
-- apunten a un usuario real.
--
-- Verificación previa (2026-05-12): las 3 tablas están vacías (0 filas).
-- Sin riesgo de data loss en la conversión.
--
-- Pasos:
--   1. Drop la RPC cambiar_sueldo_empleado (depende del tipo TEXT de
--      registrado_por). Se recrea más abajo con cast a INTEGER directo.
--   2. ALTER COLUMN TYPE INTEGER USING NULLIF(...)::integer
--      (USING garantiza que strings vacíos pasan a NULL en lugar de error).
--   3. ADD CONSTRAINT FK con ON DELETE SET NULL (auditoría débil pero
--      aceptable: si borrás el usuario, queda como "?", no rompe la fila).
--   4. Recrear cambiar_sueldo_empleado sin el cast a text.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Drop temporario de la RPC que depende del tipo viejo
DROP FUNCTION IF EXISTS cambiar_sueldo_empleado(integer, numeric, text, text);

-- 2) Cambiar tipo + agregar FK con SET NULL
ALTER TABLE rrhh_historial_sueldos
  ALTER COLUMN registrado_por TYPE integer
    USING NULLIF(NULLIF(trim(registrado_por), ''), 'null')::integer;
ALTER TABLE rrhh_historial_sueldos
  ADD CONSTRAINT rrhh_historial_sueldos_registrado_por_fkey
  FOREIGN KEY (registrado_por) REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE rrhh_documentos
  ALTER COLUMN subido_por TYPE integer
    USING NULLIF(NULLIF(trim(subido_por), ''), 'null')::integer;
ALTER TABLE rrhh_documentos
  ADD CONSTRAINT rrhh_documentos_subido_por_fkey
  FOREIGN KEY (subido_por) REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE rrhh_pagos_especiales
  ALTER COLUMN pagado_por TYPE integer
    USING NULLIF(NULLIF(trim(pagado_por), ''), 'null')::integer;
ALTER TABLE rrhh_pagos_especiales
  ADD CONSTRAINT rrhh_pagos_especiales_pagado_por_fkey
  FOREIGN KEY (pagado_por) REFERENCES usuarios(id) ON DELETE SET NULL;

-- 3) Recrear cambiar_sueldo_empleado con registrado_por como INTEGER directo.
-- Idéntica a la versión de migration 202605121710, solo cambia el ::text
-- por pasar v_usuario_id directo (ya es integer).
CREATE OR REPLACE FUNCTION cambiar_sueldo_empleado(
  p_emp_id        integer,
  p_nuevo_sueldo  numeric,
  p_motivo        text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_usuario_id integer;
  v_tenant uuid;
  v_emp RECORD;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('rrhh')) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO: requiere permiso rrhh';
  END IF;
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'AUTH_SIN_TENANT'; END IF;
  v_usuario_id := auth_usuario_id();

  IF p_emp_id IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  IF p_nuevo_sueldo IS NULL OR p_nuevo_sueldo <= 0 THEN
    RAISE EXCEPTION 'MONTO_INVALIDO';
  END IF;

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name = 'cambiar_sueldo_empleado' AND key = p_idempotency_key;
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_emp FROM rrhh_empleados WHERE id = p_emp_id FOR UPDATE;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;
  IF v_emp.tenant_id <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO: cross-tenant'; END IF;

  IF COALESCE(v_emp.sueldo_mensual, 0) = p_nuevo_sueldo THEN
    RETURN jsonb_build_object('ok', true, 'sin_cambio', true);
  END IF;

  INSERT INTO rrhh_historial_sueldos (
    empleado_id, sueldo_anterior, sueldo_nuevo, motivo, registrado_por, tenant_id
  ) VALUES (
    p_emp_id, v_emp.sueldo_mensual, p_nuevo_sueldo, nullif(trim(p_motivo), ''),
    v_usuario_id,
    v_tenant
  );

  UPDATE rrhh_empleados SET sueldo_mensual = p_nuevo_sueldo WHERE id = p_emp_id;

  v_result := jsonb_build_object(
    'ok', true,
    'emp_id', p_emp_id,
    'sueldo_anterior', v_emp.sueldo_mensual,
    'sueldo_nuevo', p_nuevo_sueldo,
    'registrado_por_uid', v_caller_uid
  );

  IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('cambiar_sueldo_empleado', p_idempotency_key, v_tenant, v_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cambiar_sueldo_empleado(integer, numeric, text, text) TO authenticated;
REVOKE ALL ON FUNCTION cambiar_sueldo_empleado(integer, numeric, text, text) FROM PUBLIC;
