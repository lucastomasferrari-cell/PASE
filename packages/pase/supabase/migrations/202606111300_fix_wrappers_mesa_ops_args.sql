-- ═══════════════════════════════════════════════════════════════════════════
-- Bug 2026-06-11 (parte 2/2): wrappers _offline de MESA-OPS con args rotos
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Continuación de 202606111200 (que arregló los 4 wrappers con inners sin
-- sufijo _comanda). Los 3 wrappers de operaciones de mesa estaban rotos de
-- otra manera — llamaban a las inners con MENOS args de los que exigen
-- (p_manager_id y p_motivo no tienen DEFAULT en las inners) y uno con el
-- orden invertido:
--
--   fn_transferir_mesa_comanda_offline → llamaba (venta, mesa) cuando la
--     inner exige (venta, mesa, manager, motivo)               → 42883
--   fn_unir_mesas_comanda_offline → llamaba (destino, origen): además de
--     faltar manager/motivo, el ORDEN está INVERTIDO respecto de la inner
--     fn_unir_mesas_comanda(origen, destino, ...) — hubiera unido las mesas
--     AL REVÉS                                                  → 42883
--   fn_partir_cuenta_comanda_offline → llamaba (venta, items)  → 42883
--
-- Fix: DROP + CREATE (cambia la firma: se agregan p_manager_id/p_motivo con
-- DEFAULT NULL — con CREATE OR REPLACE quedaría un overload duplicado y
-- PostgREST fallaría con PGRST203 ambiguous). El frontend
-- (transferenciasOfflineService) ahora transporta manager/motivo — cierra la
-- deuda "los _offline no auditan manager_id" del 19-may. Las inners validan
-- MANAGER_REQUERIDO si llega NULL (ops viejas encoladas sin manager fallan
-- con error de negocio claro, no con 42883).
--
-- Además: DROP de los 2 overloads huérfanos de firmas viejas que seguían
-- vivos (fn_agregar_item_comanda_offline 10-args y
-- fn_mandar_curso_comanda_offline 3-args) — código muerto (pushQueue siempre
-- manda p_idempotency_key) y bomba de ambigüedad PGRST203.
--
-- ACL: REVOKE FROM PUBLIC, anon (lección 202606111100: los default
-- privileges de Supabase dan EXECUTE a anon en toda función nueva).

-- ─── 0. Overloads huérfanos ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS fn_agregar_item_comanda_offline(
  BIGINT, UUID, INTEGER, NUMERIC, NUMERIC, INTEGER, JSONB, TEXT, UUID, UUID
);
DROP FUNCTION IF EXISTS fn_mandar_curso_comanda_offline(BIGINT, UUID, INTEGER);

-- ─── 1. fn_transferir_mesa_comanda_offline ──────────────────────────────────
DROP FUNCTION IF EXISTS fn_transferir_mesa_comanda_offline(BIGINT, UUID, INTEGER, UUID, TEXT);
DROP FUNCTION IF EXISTS fn_transferir_mesa_comanda_offline(BIGINT, UUID, INTEGER, UUID, TEXT, UUID, TEXT);

CREATE FUNCTION fn_transferir_mesa_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_mesa_destino_id INTEGER,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_manager_id UUID DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  -- La inner valida MANAGER_REQUERIDO si p_manager_id es NULL.
  PERFORM fn_transferir_mesa_comanda(v_venta_id, p_mesa_destino_id::BIGINT,
    p_manager_id, COALESCE(p_motivo, 'Transferencia de mesa (offline)'));
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_transferir_mesa_comanda_offline(BIGINT, UUID, INTEGER, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_transferir_mesa_comanda_offline(BIGINT, UUID, INTEGER, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── 2. fn_unir_mesas_comanda_offline — ORDEN CORRECTO origen/destino ───────
DROP FUNCTION IF EXISTS fn_unir_mesas_comanda_offline(BIGINT, UUID, BIGINT, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS fn_unir_mesas_comanda_offline(BIGINT, UUID, BIGINT, UUID, UUID, TEXT, UUID, TEXT);

CREATE FUNCTION fn_unir_mesas_comanda_offline(
  p_venta_destino_id BIGINT,
  p_venta_destino_idempotency_uuid UUID,
  p_venta_origen_id BIGINT,
  p_venta_origen_idempotency_uuid UUID,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_manager_id UUID DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_destino BIGINT;
  v_origen BIGINT;
BEGIN
  v_destino := fn_resolver_venta_id_por_uuid(p_venta_destino_id, p_venta_destino_idempotency_uuid);
  v_origen := fn_resolver_venta_id_por_uuid(p_venta_origen_id, p_venta_origen_idempotency_uuid);
  -- La firma real es (origen, destino, manager, motivo) — la versión vieja
  -- pasaba (destino, origen): hubiera unido las mesas AL REVÉS.
  PERFORM fn_unir_mesas_comanda(v_origen, v_destino,
    p_manager_id, COALESCE(p_motivo, 'Unión de mesas (offline)'));
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_unir_mesas_comanda_offline(BIGINT, UUID, BIGINT, UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_unir_mesas_comanda_offline(BIGINT, UUID, BIGINT, UUID, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── 3. fn_partir_cuenta_comanda_offline ────────────────────────────────────
DROP FUNCTION IF EXISTS fn_partir_cuenta_comanda_offline(BIGINT, UUID, BIGINT[], UUID, TEXT);
DROP FUNCTION IF EXISTS fn_partir_cuenta_comanda_offline(BIGINT, UUID, BIGINT[], UUID, TEXT, UUID, TEXT);

CREATE FUNCTION fn_partir_cuenta_comanda_offline(
  p_venta_original_id BIGINT,
  p_venta_original_idempotency_uuid UUID,
  p_item_ids BIGINT[],
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_manager_id UUID DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_original_id BIGINT;
BEGIN
  v_venta_original_id := fn_resolver_venta_id_por_uuid(p_venta_original_id, p_venta_original_idempotency_uuid);
  RETURN fn_partir_cuenta_comanda(v_venta_original_id, p_item_ids,
    p_manager_id, COALESCE(p_motivo, 'Partir cuenta (offline)'));
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_partir_cuenta_comanda_offline(BIGINT, UUID, BIGINT[], UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_partir_cuenta_comanda_offline(BIGINT, UUID, BIGINT[], UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── Smoke: contrato de los 3 wrappers ──────────────────────────────────────
DO $$
DECLARE
  v_src TEXT;
  v_n INT;
BEGIN
  -- unir: debe pasar (v_origen, v_destino) — el orden correcto.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_unir_mesas_comanda_offline';
  IF v_src !~ 'fn_unir_mesas_comanda\(v_origen,\s*v_destino' THEN
    RAISE EXCEPTION 'SMOKE FAIL: unir_mesas_offline no pasa (origen, destino)';
  END IF;

  -- los 3 deben pasar p_manager_id a la inner.
  SELECT COUNT(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_transferir_mesa_comanda_offline','fn_unir_mesas_comanda_offline','fn_partir_cuenta_comanda_offline')
     AND p.prosrc LIKE '%p_manager_id%';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % de 3 wrappers de mesa pasan p_manager_id', v_n;
  END IF;

  -- exactamente 1 overload por wrapper offline (sin huérfanos).
  SELECT COUNT(*) INTO v_n FROM (
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '%\_comanda\_offline' ESCAPE '\'
     GROUP BY p.proname HAVING COUNT(*) > 1
  ) dup;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % wrappers _comanda_offline con overloads duplicados', v_n;
  END IF;

  -- anon no puede ejecutar ninguno.
  SELECT COUNT(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE '%\_comanda\_offline' ESCAPE '\'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % wrappers ejecutables por anon', v_n;
  END IF;

  RAISE NOTICE 'SMOKE OK: mesa-ops con manager/motivo, orden correcto, sin overloads, anon bloqueado';
END $$;

NOTIFY pgrst, 'reload schema';
