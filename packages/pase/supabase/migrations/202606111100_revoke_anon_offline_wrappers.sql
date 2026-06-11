-- ═══════════════════════════════════════════════════════════════════════════
-- Seguridad 2026-06-11: REVOKE anon de los wrappers *_comanda_offline
--
-- Hallazgo (debugging 11-jun): anon podía EJECUTAR fn_anular_venta_comanda_offline
-- (verificado empíricamente — una llamada REST con solo la anon key llegó hasta el
-- RAISE del resolver). Riesgo bajo (las inner RPCs tienen auth check) pero
-- fn_resolver_venta_id_por_uuid corre ANTES del auth check → probing anónimo.
--
-- ROOT CAUSE (auditado en prod con pg_proc.proacl + pg_default_acl):
-- NO fue una migración posterior que pisó los GRANTs. Supabase define
-- ALTER DEFAULT PRIVILEGES para el rol postgres con EXECUTE a anon,
-- authenticated y service_role en TODA función nueva. La migración
-- 202605161500 solo hizo `REVOKE ALL ... FROM PUBLIC`, que NO toca el grant
-- explícito `anon=X/postgres` puesto por los default privileges en el CREATE.
-- Los wrappers fueron ejecutables por anon desde el día 1.
-- (Los resolvers están sanos porque 202605271900 sí revocó `anon` explícito.)
--
-- LECCIÓN para futuras migraciones (regla C11): `REVOKE ... FROM PUBLIC` solo
-- NO alcanza en Supabase — siempre revocar también `anon` explícitamente:
--   REVOKE EXECUTE ON FUNCTION f(...) FROM PUBLIC, anon;
--
-- Fix dinámico: recorre TODAS las firmas existentes que terminan en
-- _comanda_offline (incluye overloads huérfanos de firmas viejas, p.ej.
-- fn_agregar_item_comanda_offline 10-args y fn_mandar_curso_comanda_offline
-- 3-args, que quedaron vivos con ACL default) y normaliza:
--   REVOKE FROM PUBLIC, anon  +  GRANT a authenticated, service_role.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  r RECORD;
  v_n INT := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS firma
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE '%\_comanda\_offline' ESCAPE '\'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.firma);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.firma);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'REVOKE anon aplicado a % wrappers _comanda_offline', v_n;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: no se encontró ningún wrapper _comanda_offline';
  END IF;
END $$;

-- ─── Smoke check: ningún wrapper debe quedar ejecutable por anon ────────────
DO $$
DECLARE
  v_abiertas INT;
BEGIN
  SELECT COUNT(*) INTO v_abiertas
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE '%\_comanda\_offline' ESCAPE '\'
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_abiertas > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % wrappers _comanda_offline siguen ejecutables por anon', v_abiertas;
  END IF;

  -- authenticated debe seguir pudiendo ejecutar TODOS
  SELECT COUNT(*) INTO v_abiertas
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE '%\_comanda\_offline' ESCAPE '\'
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_abiertas > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: % wrappers _comanda_offline quedaron SIN execute para authenticated', v_abiertas;
  END IF;

  RAISE NOTICE 'SMOKE OK: anon revocado, authenticated intacto en todos los wrappers';
END $$;

NOTIFY pgrst, 'reload schema';
