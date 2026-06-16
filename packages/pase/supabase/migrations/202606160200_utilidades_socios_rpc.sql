-- 202606160200_utilidades_socios_rpc.sql
-- Upsert de un socio. Devuelve la suma de % activos del local (la UI avisa si != 100).
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_guardar_socio(
  p_local_id integer, p_id uuid, p_nombre text, p_porcentaje numeric, p_activo boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_id uuid; v_suma numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF COALESCE(TRIM(p_nombre),'') = '' THEN RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;
  IF p_porcentaje < 0 OR p_porcentaje > 100 THEN RAISE EXCEPTION 'PORCENTAJE_INVALIDO'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO utilidades_socios (tenant_id, local_id, nombre, porcentaje, activo)
    VALUES (v_tenant, p_local_id, TRIM(p_nombre), p_porcentaje, p_activo) RETURNING id INTO v_id;
  ELSE
    UPDATE utilidades_socios SET nombre=TRIM(p_nombre), porcentaje=p_porcentaje, activo=p_activo, updated_at=NOW()
    WHERE id=p_id AND tenant_id=v_tenant AND local_id=p_local_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'SOCIO_NO_ENCONTRADO'; END IF;
  END IF;

  SELECT COALESCE(SUM(porcentaje),0) INTO v_suma FROM utilidades_socios
    WHERE tenant_id=v_tenant AND local_id=p_local_id AND activo;
  RETURN jsonb_build_object('id', v_id, 'suma_porcentajes', v_suma);
END $$;
REVOKE ALL ON FUNCTION utilidades_guardar_socio(integer,uuid,text,numeric,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_guardar_socio(integer,uuid,text,numeric,boolean) TO authenticated;
COMMIT;
