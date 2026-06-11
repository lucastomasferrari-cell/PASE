-- 202606110500_auto_seed_alias_proveedor.sql
-- Lucas 10-jun: "los cambios no sean parches para mi situacion actual o
-- mis provedores sino que para un cliente nuevo lo pueda recibir
-- funcionando".
--
-- Solución general:
-- 1. Función fn_seed_alias_proveedor(prov_id) — calcula el nombre
--    normalizado del proveedor (fn_extraer_titular) y crea aliases
--    "nombre→proveedor" para TODOS los locales del tenant del proveedor.
--    Skip si el nombre es ambiguo (hay otros proveedores con el mismo
--    nombre normalizado en el mismo tenant).
-- 2. Trigger AFTER INSERT en proveedores → seed automático.
-- 3. Trigger AFTER UPDATE de nombre en proveedores → re-seed (el alias
--    viejo queda como histórico, el nuevo se crea).
-- 4. Trigger AFTER INSERT en locales → para cualquier proveedor existente
--    del tenant, seedear los aliases en el local nuevo también.
-- 5. Backfill: ejecutar fn_seed_alias_proveedor sobre TODOS los
--    proveedores activos existentes en TODOS los tenants.

CREATE OR REPLACE FUNCTION fn_seed_alias_proveedor(p_prov_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prov RECORD;
  v_titular TEXT;
  v_ambig INTEGER;
  v_insertados INTEGER := 0;
  v_local_id INTEGER;
BEGIN
  SELECT id, tenant_id, nombre INTO v_prov
  FROM proveedores WHERE id = p_prov_id;
  IF v_prov IS NULL THEN RETURN 0; END IF;

  v_titular := fn_extraer_titular(v_prov.nombre);
  IF v_titular IS NULL OR LENGTH(v_titular) < 4 THEN RETURN 0; END IF;

  -- Ambigüedad: si hay 2+ proveedores activos del mismo tenant con el
  -- mismo nombre normalizado, no seedear (genera matches falsos).
  SELECT COUNT(*) INTO v_ambig
  FROM proveedores
  WHERE tenant_id = v_prov.tenant_id
    AND estado = 'Activo'
    AND fn_extraer_titular(nombre) = v_titular;
  IF v_ambig > 1 THEN RETURN 0; END IF;

  -- Por cada local del tenant, crear el alias. ON CONFLICT DO NOTHING
  -- respeta cualquier alias manual previo (no pisa decisiones del usuario).
  FOR v_local_id IN
    SELECT id FROM locales WHERE tenant_id = v_prov.tenant_id
  LOOP
    INSERT INTO conciliacion_alias (tenant_id, local_id, titular, tipo, prov_id, veces)
    VALUES (v_prov.tenant_id, v_local_id, v_titular, 'proveedor', v_prov.id, 0)
    ON CONFLICT (tenant_id, local_id, titular) DO NOTHING;
    GET DIAGNOSTICS v_insertados = ROW_COUNT;
  END LOOP;

  RETURN v_insertados;
END;
$$;

REVOKE ALL ON FUNCTION fn_seed_alias_proveedor(INTEGER) FROM PUBLIC, anon;
-- Solo el sistema (triggers SECURITY DEFINER) y dueños/admins via service
-- la usan. No la expongo a authenticated para evitar abuso (un encargado
-- podría seedear aliases incorrectos masivamente sino).

-- ── Trigger en proveedores: INSERT ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_trg_seed_alias_prov_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM fn_seed_alias_proveedor(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_alias_prov_insert ON proveedores;
CREATE TRIGGER trg_seed_alias_prov_insert
  AFTER INSERT ON proveedores
  FOR EACH ROW EXECUTE FUNCTION fn_trg_seed_alias_prov_insert();

-- ── Trigger en proveedores: UPDATE nombre ─────────────────────────────
-- Si cambia el nombre, re-seedea (el alias viejo queda como histórico
-- para no romper conciliaciones cerradas con el nombre anterior).
CREATE OR REPLACE FUNCTION fn_trg_seed_alias_prov_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.nombre IS DISTINCT FROM NEW.nombre THEN
    PERFORM fn_seed_alias_proveedor(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_alias_prov_update ON proveedores;
CREATE TRIGGER trg_seed_alias_prov_update
  AFTER UPDATE ON proveedores
  FOR EACH ROW EXECUTE FUNCTION fn_trg_seed_alias_prov_update();

-- ── Trigger en locales: INSERT ────────────────────────────────────────
-- Cuando se crea un local nuevo en un tenant existente, seedear todos los
-- aliases de los proveedores ya existentes para que el local nuevo arranque
-- con el mismo nivel de matching que los locales viejos.
CREATE OR REPLACE FUNCTION fn_trg_seed_alias_local_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prov_id INTEGER; BEGIN
  FOR v_prov_id IN
    SELECT id FROM proveedores WHERE tenant_id = NEW.tenant_id AND estado = 'Activo'
  LOOP
    PERFORM fn_seed_alias_proveedor(v_prov_id);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_alias_local_insert ON locales;
CREATE TRIGGER trg_seed_alias_local_insert
  AFTER INSERT ON locales
  FOR EACH ROW EXECUTE FUNCTION fn_trg_seed_alias_local_insert();

-- ── BACKFILL: todos los proveedores activos de todos los tenants ──────
-- (los aliases que precargué a mano para Rene quedan; los del resto de
-- tenants/locales se crean ahora).
DO $$
DECLARE v_pid INTEGER; v_count INTEGER := 0; BEGIN
  FOR v_pid IN SELECT id FROM proveedores WHERE estado = 'Activo'
  LOOP
    PERFORM fn_seed_alias_proveedor(v_pid);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Seed alias proveedor: % proveedores procesados', v_count;
END $$;

NOTIFY pgrst, 'reload schema';
