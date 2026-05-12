-- ═══════════════════════════════════════════════════════════════════════════
-- Abrir lectura de config_categorias a cualquier user del tenant (encargados
-- incluidos). Mantener escritura restringida a permiso 'configuracion'.
--
-- Bug detectado 2026-05-12: la policy unificada `config_categorias_mt`
-- exigía `auth_tiene_permiso('configuracion')` también para SELECT. Los
-- encargados (sin ese permiso) recibían 0 rows en el SELECT que hace el hook
-- useCategorias y caían silenciosamente al FALLBACK hardcoded de constants.ts.
-- Resultado visible: Caro (encargada) no veía RETIROS_SOCIOS (fallback vacío)
-- ni las categorías nuevas creadas vía Configuración, en formularios de
-- Gastos / ConciliacionMP / etc.
--
-- Esta tabla es master data global por tenant — todos los usuarios necesitan
-- LEER para que los dropdowns de categoría se llenen. Solo los administradores
-- pueden agregar/editar/borrar conceptos (eso ya estaba bien gateado en la UI
-- de Configuración con tienePermiso("configuracion")).
--
-- Patrón aplicado: el "Master data global" documentado en CLAUDE.md sección
-- "Agregar tabla nueva — checklist obligatorio" caso B.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS config_categorias_mt ON config_categorias;

-- SELECT: cualquier user del tenant (más superadmin global).
CREATE POLICY config_categorias_select ON config_categorias
  FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());

-- INSERT/UPDATE/DELETE: requiere permiso 'configuracion' (dueño/admin).
CREATE POLICY config_categorias_write ON config_categorias
  FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')));
