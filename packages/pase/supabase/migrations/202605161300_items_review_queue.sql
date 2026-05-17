-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 2 competitor F #10 — Item review queue post-OCR/import
--
-- Cuando se importan items desde Maxirest, scanéo IA, o se crean rápido, es
-- común que queden incompletos: sin foto, sin grupo, sin precio, sin receta,
-- sin tiempo de prep, sin estación de cocina. Esos items operan a media,
-- generan reportes pobres y se pierden insights (CMV, color tile, ruta KDS).
--
-- Toast/Lightspeed/Square tienen un "Setup checklist" o "Item review queue":
-- una lista de items que necesitan atención, con qué les falta + acceso al
-- editor + opción de "marcar revisado" cuando es intencional.
--
-- Implementación liviana:
--   - Columna items.revisado_completo_at: timestamp si el manager marcó OK.
--   - Vista v_items_review_queue: items con score de completitud + qué falta.
--   - RPC fn_marcar_item_revisado(p_item_id).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS revisado_completo_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS revisado_completo_por INTEGER NULL REFERENCES usuarios(id);

COMMENT ON COLUMN items.revisado_completo_at IS
  'Sprint 2 F #10: timestamp cuando el manager marcó este item como "revisado completo" (sale de la review queue aunque le falten campos opcionales).';

-- ─── Vista v_items_review_queue ────────────────────────────────────────────
-- Score de completitud (0-100) ponderando heurísticas. Items con score < 70
-- aparecen en la cola por default. Las flags individuales permiten al usuario
-- filtrar "mostrame solo los sin foto" o "los que les falta grupo".
CREATE OR REPLACE VIEW v_items_review_queue AS
SELECT
  i.id,
  i.tenant_id,
  i.nombre,
  i.emoji,
  i.foto_url,
  i.grupo_id,
  i.precio_madre,
  i.estacion,
  i.tax_rate_id,
  i.receta_id_vigente,
  i.estado,
  i.visible_pos,
  i.revisado_completo_at,
  i.created_at,
  -- Flags individuales (boolean)
  (i.foto_url IS NULL AND i.emoji IS NULL)        AS falta_visual,    -- ni foto ni emoji
  (i.grupo_id IS NULL)                            AS falta_grupo,
  (i.precio_madre IS NULL OR i.precio_madre <= 0) AS falta_precio,
  (i.estacion IS NULL)                            AS falta_estacion,
  (i.tax_rate_id IS NULL)                         AS falta_tax,
  (i.receta_id_vigente IS NULL)                   AS falta_receta,
  (i.descripcion IS NULL OR length(trim(i.descripcion)) < 5) AS falta_descripcion,
  -- Score: 100 - sum(penalties)
  GREATEST(0,
    100
    - CASE WHEN i.foto_url IS NULL AND i.emoji IS NULL THEN 25 ELSE 0 END  -- visual crítico
    - CASE WHEN i.grupo_id IS NULL THEN 20 ELSE 0 END                       -- afecta navegación POS
    - CASE WHEN i.precio_madre IS NULL OR i.precio_madre <= 0 THEN 30 ELSE 0 END  -- crítico
    - CASE WHEN i.estacion IS NULL THEN 10 ELSE 0 END                       -- afecta KDS
    - CASE WHEN i.tax_rate_id IS NULL THEN 5 ELSE 0 END
    - CASE WHEN i.receta_id_vigente IS NULL THEN 5 ELSE 0 END               -- afecta CMV
    - CASE WHEN i.descripcion IS NULL OR length(trim(i.descripcion)) < 5 THEN 5 ELSE 0 END
  ) AS score_completitud
FROM items i
WHERE i.deleted_at IS NULL
  AND i.estado IN ('disponible', 'agotado');

GRANT SELECT ON v_items_review_queue TO authenticated, service_role;

COMMENT ON VIEW v_items_review_queue IS
  'Sprint 2 F #10: items + score de completitud + qué falta. Filtrar revisado_completo_at IS NULL para ver pendientes. Items con score < 70 son los que más urgen revisión.';

-- ─── RPC: marcar item revisado ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_marcar_item_revisado(
  p_item_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('compras') OR auth_es_superadmin()) THEN
    RAISE EXCEPTION 'SIN_PERMISO';
  END IF;

  UPDATE items SET
    revisado_completo_at = NOW(),
    revisado_completo_por = auth_usuario_id(),
    updated_at = NOW()
  WHERE id = p_item_id
    AND (auth_es_superadmin() OR tenant_id = v_tenant);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_ENCONTRADO';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_marcar_item_revisado(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_marcar_item_revisado(INTEGER) TO authenticated;

-- ─── RPC: deshacer marca (volver a poner en cola) ──────────────────────────
CREATE OR REPLACE FUNCTION fn_desmarcar_item_revisado(
  p_item_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;

  UPDATE items SET
    revisado_completo_at = NULL,
    revisado_completo_por = NULL,
    updated_at = NOW()
  WHERE id = p_item_id
    AND (auth_es_superadmin() OR tenant_id = v_tenant);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_ENCONTRADO';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_desmarcar_item_revisado(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_desmarcar_item_revisado(INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
