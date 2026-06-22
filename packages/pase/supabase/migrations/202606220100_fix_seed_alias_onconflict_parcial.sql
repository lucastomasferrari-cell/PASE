-- 202606220100_fix_seed_alias_onconflict_parcial.sql
-- BUG: crear/renombrar un proveedor fallaba con "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification".
-- Causa: el trigger trg_seed_alias_prov_insert/update llama a
-- fn_seed_alias_proveedor, que hace ON CONFLICT (tenant_id, local_id, titular).
-- La migración de aliases tenant-wide (Pieza 2a) reemplazó esa unique constraint
-- por DOS índices PARCIALES:
--   conciliacion_alias_local_uq  : UNIQUE (tenant_id, local_id, titular) WHERE local_id IS NOT NULL
--   conciliacion_alias_global_uq : UNIQUE (tenant_id, titular)           WHERE local_id IS NULL
-- Postgres NO infiere un índice parcial en ON CONFLICT salvo que se incluya su
-- predicado. La función siempre inserta con local_id NOT NULL (recorre
-- locales.id), así que el target correcto es conciliacion_alias_local_uq.
-- Fix: agregar WHERE local_id IS NOT NULL al ON CONFLICT.
CREATE OR REPLACE FUNCTION public.fn_seed_alias_proveedor(p_prov_id integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- El WHERE local_id IS NOT NULL apunta al índice parcial conciliacion_alias_local_uq.
  FOR v_local_id IN
    SELECT id FROM locales WHERE tenant_id = v_prov.tenant_id
  LOOP
    INSERT INTO conciliacion_alias (tenant_id, local_id, titular, tipo, prov_id, veces)
    VALUES (v_prov.tenant_id, v_local_id, v_titular, 'proveedor', v_prov.id, 0)
    ON CONFLICT (tenant_id, local_id, titular) WHERE local_id IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_insertados = ROW_COUNT;
  END LOOP;

  RETURN v_insertados;
END;
$function$;

NOTIFY pgrst, 'reload schema';
