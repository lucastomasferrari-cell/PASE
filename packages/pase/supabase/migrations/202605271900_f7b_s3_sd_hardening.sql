-- =============================================================================
-- F7B-S3: triage de SECURITY DEFINER funcs sin auth check explícito
-- =============================================================================
-- Auditoría F7B detectó 96 SD funcs sin auth check via heurística. Re-run
-- con regex mejorado dejó 36. Clasificación manual:
--
--   - 18 son PÚBLICAS LEGÍTIMAS (storefront, KDS, menú QR, marketplace,
--     rider PWA, reservas, reviews) — validan con p_token interno. Skip.
--   - 9 son COMANDA _offline wrappers — delegan a non-offline que SÍ tiene
--     check. F2B ya verificó. Skip (defense-in-depth queda pendiente).
--   - 7 son helpers backend/cron que NO deberían ser callable por
--     authenticated → REVOKE en esta migration.
--   - 2 son RPCs batch creadas en F3 sin check → AGREGAR check.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. REVOKE de helpers backend/cron callable por authenticated por default.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.fn_calcular_costo_receta_porcion(bigint, bigint, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_oauth_states() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_reactivar_items_vencidos() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_resolver_venta_id_por_uuid(bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_resolver_venta_item_id_por_uuid(bigint, uuid) FROM PUBLIC, anon, authenticated;
-- fn_reporte_cmv_resumen: lo usa Gastro-Sensei pero a través de /api/claude
-- que tiene SUPABASE_SERVICE_KEY → puede llamar directo. authenticated no
-- necesita acceso directo (la página de CMV usa fn_cmv_real que tiene check).
REVOKE EXECUTE ON FUNCTION public.fn_reporte_cmv_resumen(integer, date, date) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. RPCs batch creadas en F3 — agregar auth check explícito (defense-in-depth).
-- Hoy delegan a la non-batch que SÍ tiene check, pero conviene tenerlo
-- también acá. F7B-S3 lo flageó.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.anular_movimientos_batch(
  p_mov_ids text[],
  p_motivo text,
  p_override_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_ok integer := 0;
  v_fail integer := 0;
BEGIN
  -- AUDIT F7B-S3: auth check defense-in-depth. La RPC delegada
  -- anular_movimiento tiene su propio check, pero acá frenamos antes.
  IF auth_tenant_id() IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  IF p_mov_ids IS NULL OR array_length(p_mov_ids, 1) = 0 THEN
    RAISE EXCEPTION 'MOV_IDS_REQUERIDOS';
  END IF;
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  FOREACH v_id IN ARRAY p_mov_ids
  LOOP
    BEGIN
      v_result := anular_movimiento(v_id, p_motivo, p_override_code);
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'mov_id', v_id,
        'ok', true,
        'result', v_result
      ));
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'mov_id', v_id,
        'ok', false,
        'error', SQLERRM
      ));
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'anulados', v_ok,
    'fallidos', v_fail,
    'detalles', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.anular_movimientos_batch(text[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anular_movimientos_batch(text[], text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.aplicar_ncs_a_factura(
  p_factura_id text,
  p_ncs jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_ok integer := 0;
  v_fail integer := 0;
BEGIN
  -- AUDIT F7B-S3: auth check defense-in-depth.
  IF auth_tenant_id() IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'NO_AUTH';
  END IF;

  IF p_ncs IS NULL OR jsonb_array_length(p_ncs) = 0 THEN
    RAISE EXCEPTION 'NCS_REQUERIDAS';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_ncs)
  LOOP
    BEGIN
      v_result := aplicar_nc_a_factura(
        p_nc_id          := v_item->>'nc_id',
        p_factura_id     := p_factura_id,
        p_monto          := (v_item->>'monto')::numeric,
        p_fecha          := (v_item->>'fecha')::date,
        p_idempotency_key := v_item->>'idempotency_key'
      );
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'nc_id', v_item->>'nc_id',
        'ok', true,
        'result', v_result
      ));
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'nc_id', v_item->>'nc_id',
        'ok', false,
        'error', SQLERRM
      ));
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'factura_id', p_factura_id,
    'aplicadas', v_ok,
    'fallidas', v_fail,
    'detalles', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.aplicar_ncs_a_factura(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aplicar_ncs_a_factura(text, jsonb) TO authenticated, service_role;

-- Smoke
DO $smoke$
DECLARE v_n int;
BEGIN
  -- Verificar que los 6 helpers están REVOKED de authenticated
  SELECT COUNT(*) INTO v_n
  FROM information_schema.routine_privileges
  WHERE specific_schema='public' AND grantee='authenticated' AND privilege_type='EXECUTE'
    AND routine_name IN ('fn_calcular_costo_receta_porcion','fn_cleanup_oauth_states',
                         'fn_reactivar_items_vencidos','fn_resolver_venta_id_por_uuid',
                         'fn_resolver_venta_item_id_por_uuid','fn_reporte_cmv_resumen');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL F7B-S3: % helpers todavía con GRANT a authenticated', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK F7B-S3: helpers REVOKEd de authenticated';
END $smoke$;

COMMIT;
