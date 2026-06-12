-- ============================================================
-- 202606121000_fix_snapshot_receta_idempotencia.sql
-- Bug: fn_snapshot_receta_a_version (202605151500:259) incluye
-- 'snapshot_at', NOW() dentro de receta_data y la idempotencia
-- compara receta_data = v_receta_data por igualdad JSONB total
-- → dos llamadas separadas NUNCA son iguales → cada cobro de
-- venta COMANDA con receta crea una versión nueva en vez de
-- reusar (duplicados reales en prod: versiones 347/348, 377/378
-- del 09-jun). Detectado por el assert de idempotencia de
-- tests/cmv_insumos_recetas_mutante.spec.ts.
--
-- Fix: comparar excluyendo la clave 'snapshot_at' (operador
-- jsonb - text). Se conserva snapshot_at en el payload por
-- compatibilidad con las versiones ya guardadas.
-- Las versiones duplicadas históricas se dejan (inmutables,
-- inofensivas, potencialmente referenciadas por ventas).
--
-- Base copiada ÍNTEGRA de la vigente 202605151500:259-344;
-- único cambio funcional: el WHERE de idempotencia.
-- + REVOKE actualizado a la regla 11-jun (PUBLIC, anon).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_snapshot_receta_a_version(
  p_item_id INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_receta RECORD;
  v_receta_data JSONB;
  v_existing_id BIGINT;
  v_next_version INTEGER;
  v_new_id BIGINT;
BEGIN
  -- C11 auth check primero.
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;

  -- Buscar receta viva activa para el item. Si hay >1 (global + local override),
  -- preferir la local del usuario actual.
  SELECT r.* INTO v_receta
  FROM recetas r
  WHERE r.item_id = p_item_id
    AND r.activa = TRUE
    AND r.deleted_at IS NULL
    AND (auth_es_superadmin() OR r.tenant_id = v_tenant_id)
  ORDER BY r.local_id NULLS LAST -- prefiere local sobre global
  LIMIT 1;

  IF v_receta IS NULL THEN
    -- Item sin receta — devolvemos NULL (la venta se cobra igual, sin CMV).
    RETURN NULL;
  END IF;

  -- Componer JSONB con la receta + sus insumos.
  SELECT jsonb_build_object(
    'receta_id', v_receta.id,
    'receta_nombre', v_receta.nombre,
    'rendimiento', v_receta.rendimiento,
    'snapshot_at', NOW(),
    'insumos', COALESCE(jsonb_agg(jsonb_build_object(
      'insumo_id', ri.insumo_id,
      'insumo_nombre', i.nombre,
      'insumo_unidad', i.unidad,
      'cantidad', ri.cantidad,
      'merma_pct', ri.merma_pct,
      'costo_unitario_snapshot', i.costo_actual,
      'notas', ri.notas
    ) ORDER BY ri.orden, ri.id) FILTER (WHERE ri.id IS NOT NULL), '[]'::jsonb)
  ) INTO v_receta_data
  FROM (SELECT v_receta.id AS rid) r
  LEFT JOIN receta_insumos ri ON ri.receta_id = r.rid AND ri.deleted_at IS NULL
  LEFT JOIN insumos i ON i.id = ri.insumo_id;

  -- Idempotency FIX: comparar SIN 'snapshot_at' (la clave que cambia siempre).
  SELECT id INTO v_existing_id
  FROM recetas_versiones
  WHERE item_id = p_item_id
    AND (receta_data - 'snapshot_at') = (v_receta_data - 'snapshot_at')
  ORDER BY version_numero DESC
  LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Calcular próximo version_numero para este item.
  SELECT COALESCE(MAX(version_numero), 0) + 1 INTO v_next_version
  FROM recetas_versiones
  WHERE item_id = p_item_id;

  INSERT INTO recetas_versiones (tenant_id, item_id, version_numero, receta_data, notas)
  VALUES (
    COALESCE(v_tenant_id, v_receta.tenant_id),
    p_item_id,
    v_next_version,
    v_receta_data,
    'Snapshot auto-generado por fn_snapshot_receta_a_version'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_snapshot_receta_a_version FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_snapshot_receta_a_version TO authenticated, service_role;

COMMENT ON FUNCTION fn_snapshot_receta_a_version IS
  'F1.1: snapshot inmutable de receta viva al momento de cobro. Idempotente por contenido (excluyendo snapshot_at — fix 12-jun). Llamada desde RPC fn_cobrar_venta_comanda en cada item con receta vigente.';

COMMIT;
