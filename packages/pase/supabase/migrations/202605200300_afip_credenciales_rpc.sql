-- ═══════════════════════════════════════════════════════════════════════════
-- AFIP — RPCs para CRUD de credenciales desde el frontend admin
--
-- Hoy la pantalla /configuracion/afip no puede escribir directamente en
-- afip_credenciales porque cert_pem + key_pem tienen column-level grants
-- (REVOKE SELECT FROM authenticated, GRANT solo a service_role).
--
-- 2 RPCs SECURITY DEFINER que validan caller y permiten upsert / delete:
--   - fn_upsert_afip_credenciales(...): valida es dueño/admin del tenant,
--     valida formato CUIT, inserta/actualiza la fila del tenant. Es UPSERT
--     porque hay 1 sola fila por tenant (PRIMARY KEY tenant_id).
--   - fn_eliminar_afip_credenciales(): borra la fila completa. Util si el
--     cert venció y querés empezar de cero.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_upsert_afip_credenciales(
  p_cuit TEXT,
  p_ambiente TEXT,
  p_punto_venta INTEGER,
  p_tipo_contribuyente TEXT,
  p_cert_pem TEXT,
  p_key_pem TEXT,
  p_activa BOOLEAN DEFAULT FALSE,
  p_cert_vence_at TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id INTEGER;
BEGIN
  -- Auth check: caller debe ser dueño/admin del tenant.
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_NO_RESUELTO';
  END IF;

  -- Validaciones
  IF p_cuit !~ '^\d{11}$' THEN
    RAISE EXCEPTION 'CUIT_FORMATO_INVALIDO';
  END IF;
  IF p_ambiente NOT IN ('testing', 'produccion') THEN
    RAISE EXCEPTION 'AMBIENTE_INVALIDO';
  END IF;
  IF p_tipo_contribuyente NOT IN ('monotributo', 'responsable_inscripto', 'exento') THEN
    RAISE EXCEPTION 'TIPO_CONTRIBUYENTE_INVALIDO';
  END IF;
  IF p_punto_venta IS NULL OR p_punto_venta <= 0 THEN
    RAISE EXCEPTION 'PUNTO_VENTA_INVALIDO';
  END IF;
  IF p_cert_pem IS NULL OR length(p_cert_pem) < 100 THEN
    RAISE EXCEPTION 'CERT_PEM_INVALIDO';
  END IF;
  IF p_key_pem IS NULL OR length(p_key_pem) < 100 THEN
    RAISE EXCEPTION 'KEY_PEM_INVALIDO';
  END IF;

  -- Lookup usuario_id para created_by
  SELECT u.id INTO v_user_id
    FROM usuarios u
    WHERE u.auth_id = auth.uid()
    LIMIT 1;

  -- Upsert: 1 fila por tenant (PK = tenant_id).
  INSERT INTO afip_credenciales (
    tenant_id, cuit, ambiente, punto_venta, tipo_contribuyente,
    cert_pem, key_pem, cert_vence_at, activa, created_by
  ) VALUES (
    v_tenant_id, p_cuit, p_ambiente, p_punto_venta, p_tipo_contribuyente,
    p_cert_pem, p_key_pem, p_cert_vence_at, p_activa, v_user_id
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    cuit = EXCLUDED.cuit,
    ambiente = EXCLUDED.ambiente,
    punto_venta = EXCLUDED.punto_venta,
    tipo_contribuyente = EXCLUDED.tipo_contribuyente,
    cert_pem = EXCLUDED.cert_pem,
    key_pem = EXCLUDED.key_pem,
    cert_vence_at = EXCLUDED.cert_vence_at,
    activa = EXCLUDED.activa,
    updated_at = NOW();
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_upsert_afip_credenciales(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_upsert_afip_credenciales(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION fn_upsert_afip_credenciales(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TIMESTAMPTZ) IS
  'Upsert de credenciales AFIP del tenant. Caller debe ser dueño/admin. Valida formato CUIT + campos requeridos. PK tenant_id → 1 fila por tenant.';


CREATE OR REPLACE FUNCTION fn_eliminar_afip_credenciales()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  IF NOT auth_es_dueno_o_admin() THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_NO_RESUELTO';
  END IF;
  DELETE FROM afip_credenciales WHERE tenant_id = v_tenant_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_eliminar_afip_credenciales() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_eliminar_afip_credenciales() TO authenticated;

COMMENT ON FUNCTION fn_eliminar_afip_credenciales() IS
  'Elimina la fila de credenciales AFIP del tenant del caller. Borrar es reversible: el dueño puede volver a subir cert + key en la pantalla.';

NOTIFY pgrst, 'reload schema';
