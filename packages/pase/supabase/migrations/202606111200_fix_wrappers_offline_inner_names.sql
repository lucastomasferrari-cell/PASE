-- ═══════════════════════════════════════════════════════════════════════════
-- Bug 2026-06-11: 4 wrappers *_comanda_offline llaman inners INEXISTENTES
--
-- Descubierto verificando el fix de ACL (202606111100): un probe authenticated
-- contra fn_anular_venta_comanda_offline devolvió
--   42883: function fn_anular_venta(bigint, uuid, text, text) does not exist
--
-- Auditoría sistemática en prod (pg_proc): 4 de los 9 wrappers offline llaman
-- a funciones SIN el sufijo _comanda, que nunca existieron en este schema:
--   fn_anular_venta_comanda_offline          → fn_anular_venta          ❌
--   fn_anular_item_comanda_offline           → fn_anular_item           ❌
--   fn_cortesia_item_comanda_offline         → fn_cortesia_item         ❌
--   fn_modificar_precio_item_comanda_offline → fn_modificar_precio_item ❌
-- Las inners reales se llaman *_comanda desde su creación (202605051800,
-- 202605091210, 202605160000). Los wrappers nacieron rotos en 202605161500 y
-- el bug se copió en 202605212300 (CRIT-9). Resultado: anular venta/item,
-- cortesía y modificar precio POR LA VÍA OFFLINE nunca funcionaron — cada
-- replay de la cola offline falla con 42883 y la pendiente queda atascada.
-- Probable raíz del "404 / pendientes atascadas al anular venta" del 11-jun.
--
-- Fix: recrear los 4 wrappers apuntando a las inners *_comanda. Detalle de
-- firmas: fn_cortesia_item_comanda y fn_modificar_precio_item_comanda reciben
-- INTEGER como item_id (no BIGINT) → cast explícito, porque bigint→integer no
-- es coerción implícita en la resolución de funciones de Postgres.
--
-- ACL: CREATE OR REPLACE con firma idéntica preserva los grants saneados por
-- 202606111100, pero re-aplicamos REVOKE/GRANT defensivo (lección: los default
-- privileges de Supabase dan EXECUTE a anon en toda función nueva).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Pre-check: las inners correctas deben existir ──────────────────────────
DO $$
BEGIN
  IF to_regprocedure('fn_anular_venta_comanda(bigint,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK FAIL: falta fn_anular_venta_comanda(bigint,uuid,text,text)';
  END IF;
  IF to_regprocedure('fn_anular_item_comanda(bigint,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK FAIL: falta fn_anular_item_comanda(bigint,uuid,text,text)';
  END IF;
  IF to_regprocedure('fn_cortesia_item_comanda(integer,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK FAIL: falta fn_cortesia_item_comanda(integer,uuid,text,text)';
  END IF;
  IF to_regprocedure('fn_modificar_precio_item_comanda(integer,numeric,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECHECK FAIL: falta fn_modificar_precio_item_comanda(integer,numeric,uuid,text,text)';
  END IF;
END $$;

-- ─── fn_anular_venta_comanda_offline ────────────────────────────────────────
-- Body fiel a 202605161500; solo cambia fn_anular_venta → fn_anular_venta_comanda.
CREATE OR REPLACE FUNCTION fn_anular_venta_comanda_offline(
  p_venta_id BIGINT,
  p_venta_idempotency_uuid UUID,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id BIGINT;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  PERFORM fn_anular_venta_comanda(v_venta_id, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_anular_venta_comanda_offline(BIGINT, UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_anular_venta_comanda_offline(BIGINT, UUID, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── fn_anular_item_comanda_offline ─────────────────────────────────────────
-- Body fiel a 202605212300 (CRIT-9); solo cambia fn_anular_item → fn_anular_item_comanda.
CREATE OR REPLACE FUNCTION fn_anular_item_comanda_offline(
  p_item_id BIGINT,
  p_item_idempotency_uuid UUID,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item_id BIGINT;
  v_dedup_id BIGINT;
  v_dedup_item_id BIGINT;
  v_override_id BIGINT;
BEGIN
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);

  -- CRIT-9: dedup con coherencia de args.
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id, venta_item_id INTO v_dedup_id, v_dedup_item_id
      FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN
      IF v_dedup_item_id IS DISTINCT FROM v_item_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_UUID_REUSE: UUID % ya consumido para item %, intentando item %',
          p_idempotency_uuid, v_dedup_item_id, v_item_id;
      END IF;
      RETURN; -- retry legítimo
    END IF;
  END IF;

  PERFORM fn_anular_item_comanda(v_item_id, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_override_id FROM ventas_pos_overrides
      WHERE venta_item_id = v_item_id AND accion = 'void'
        AND idempotency_uuid IS NULL
      ORDER BY id DESC LIMIT 1;
    IF v_override_id IS NOT NULL THEN
      UPDATE ventas_pos_overrides SET idempotency_uuid = p_idempotency_uuid
        WHERE id = v_override_id;
    END IF;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_anular_item_comanda_offline(BIGINT, UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_anular_item_comanda_offline(BIGINT, UUID, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── fn_cortesia_item_comanda_offline ───────────────────────────────────────
-- Body fiel a 202605212300; fn_cortesia_item → fn_cortesia_item_comanda + cast
-- ::INTEGER (la inner recibe INTEGER, no BIGINT).
CREATE OR REPLACE FUNCTION fn_cortesia_item_comanda_offline(
  p_item_id BIGINT,
  p_item_idempotency_uuid UUID,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item_id BIGINT;
  v_dedup_id BIGINT;
  v_dedup_item_id BIGINT;
  v_override_id BIGINT;
BEGIN
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);

  -- CRIT-9
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id, venta_item_id INTO v_dedup_id, v_dedup_item_id
      FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN
      IF v_dedup_item_id IS DISTINCT FROM v_item_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_UUID_REUSE: UUID % ya consumido para item %, intentando item %',
          p_idempotency_uuid, v_dedup_item_id, v_item_id;
      END IF;
      RETURN;
    END IF;
  END IF;

  PERFORM fn_cortesia_item_comanda(v_item_id::INTEGER, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_override_id FROM ventas_pos_overrides
      WHERE venta_item_id = v_item_id AND accion = 'comp'
        AND idempotency_uuid IS NULL
      ORDER BY id DESC LIMIT 1;
    IF v_override_id IS NOT NULL THEN
      UPDATE ventas_pos_overrides SET idempotency_uuid = p_idempotency_uuid
        WHERE id = v_override_id;
    END IF;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_cortesia_item_comanda_offline(BIGINT, UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_cortesia_item_comanda_offline(BIGINT, UUID, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── fn_modificar_precio_item_comanda_offline ───────────────────────────────
-- Body fiel a 202605212300; fn_modificar_precio_item → fn_modificar_precio_item_comanda
-- + cast ::INTEGER.
CREATE OR REPLACE FUNCTION fn_modificar_precio_item_comanda_offline(
  p_item_id BIGINT,
  p_item_idempotency_uuid UUID,
  p_precio_nuevo NUMERIC,
  p_manager_id UUID,
  p_motivo TEXT,
  p_idempotency_uuid UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item_id BIGINT;
  v_dedup_id BIGINT;
  v_dedup_item_id BIGINT;
  v_override_id BIGINT;
BEGIN
  v_item_id := fn_resolver_venta_item_id_por_uuid(p_item_id, p_item_idempotency_uuid);

  -- CRIT-9
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id, venta_item_id INTO v_dedup_id, v_dedup_item_id
      FROM ventas_pos_overrides WHERE idempotency_uuid = p_idempotency_uuid;
    IF v_dedup_id IS NOT NULL THEN
      IF v_dedup_item_id IS DISTINCT FROM v_item_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_UUID_REUSE: UUID % ya consumido para item %, intentando item %',
          p_idempotency_uuid, v_dedup_item_id, v_item_id;
      END IF;
      RETURN;
    END IF;
  END IF;

  PERFORM fn_modificar_precio_item_comanda(v_item_id::INTEGER, p_precio_nuevo, p_manager_id, p_motivo,
    COALESCE(p_idempotency_key, p_idempotency_uuid::TEXT));
  IF p_idempotency_uuid IS NOT NULL THEN
    SELECT id INTO v_override_id FROM ventas_pos_overrides
      WHERE venta_item_id = v_item_id AND accion = 'discount'
        AND idempotency_uuid IS NULL
      ORDER BY id DESC LIMIT 1;
    IF v_override_id IS NOT NULL THEN
      UPDATE ventas_pos_overrides SET idempotency_uuid = p_idempotency_uuid
        WHERE id = v_override_id;
    END IF;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_modificar_precio_item_comanda_offline(BIGINT, UUID, NUMERIC, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_modificar_precio_item_comanda_offline(BIGINT, UUID, NUMERIC, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ─── Smoke: ningún wrapper offline puede referenciar inners inexistentes ────
DO $$
DECLARE
  r RECORD;
  v_bad TEXT := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS firma, p.prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE '%\_comanda\_offline' ESCAPE '\'
  LOOP
    IF r.prosrc ~ 'fn_anular_venta\s*\(' OR r.prosrc ~ 'fn_anular_item\s*\('
       OR r.prosrc ~ 'fn_cortesia_item\s*\(' OR r.prosrc ~ 'fn_modificar_precio_item\s*\(' THEN
      v_bad := v_bad || ' ' || r.firma;
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'SMOKE FAIL: wrappers siguen llamando inners sin sufijo _comanda:%', v_bad;
  END IF;
  RAISE NOTICE 'SMOKE OK: los 4 wrappers apuntan a las inners *_comanda';
END $$;

NOTIFY pgrst, 'reload schema';
