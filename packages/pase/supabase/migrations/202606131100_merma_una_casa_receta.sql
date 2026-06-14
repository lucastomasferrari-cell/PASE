-- 202606131100_merma_una_casa_receta.sql
-- ─────────────────────────────────────────────────────────────────────────
-- "Una casa por concepto" (informe 2026-06-11, hallazgo H3 / Tier 3 #12):
-- la merma/rendimiento vivía en DOS lugares que se multiplican entre sí y
-- inflaban el costo del plato ~2x sin aviso:
--
--   (1) materias_primas.merma_pct  → en fn_recalc_costo_insumo:
--          costo_insumo = precio / (factor × (1 − merma/100))      ← INFLA acá
--   (2) receta_insumos.merma_pct   → en fn_calcular_costo_receta:
--          linea = cantidad × costo_insumo × (1 + merma/100)        ← INFLA otra vez
--
-- Si un usuario cargaba merma en la materia prima Y en la línea de receta, el
-- costo se inflaba dos veces. La decisión operativa acordada (07-jun) es:
-- **el stock se cuenta as-bought y la merma/rendimiento (fileteado, limpieza,
-- prep) se carga en la LÍNEA DE RECETA**. Por lo tanto la única casa del
-- concepto es receta_insumos.merma_pct, y el costo del insumo pasa a ser
-- as-bought puro: precio / factor.
--
-- IMPACTO EN DATOS EXISTENTES: NINGUNO. Verificado en prod (2026-06-13):
-- 0 materias_primas con merma_pct > 0, 0 de 626 receta_insumos con merma > 0,
-- 0 insumos con doble conteo. Con merma = 0, (1 − 0/100) = 1, así que la
-- fórmula nueva (precio/factor) da idéntico número que la vieja para todo lo
-- cargado hoy. Es el momento más barato de corregirlo (informe dixit).
--
-- Nota: el preview de costo del form de PASE (MateriasPrimas.tsx) y la columna
-- de la lista YA mostraban precio/factor (sin merma) — esta migración alinea
-- el costo guardado del insumo con lo que la UI ya venía mostrando.
-- ─────────────────────────────────────────────────────────────────────────

-- ── fn_recalc_costo_insumo: costo as-bought (sin aplicar merma de la MP) ──
-- Copia EXACTA de la versión vigente (202605292030) cambiando SOLO la fórmula
-- del AVG: se quita el término × (1 − merma_pct/100).
CREATE OR REPLACE FUNCTION public.fn_recalc_costo_insumo(p_insumo_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_costo_promedio NUMERIC;
  v_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  -- Permitir: superadmin, service_role (sin sesión), o mismo tenant.
  IF NOT auth_es_superadmin()
     AND auth_tenant_id() IS NOT NULL
     AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  -- Costo as-bought: precio por unidad de compra / factor de conversión.
  -- La merma/rendimiento NO se aplica acá (vive en receta_insumos.merma_pct).
  SELECT AVG(
    precio_actual / NULLIF(factor_conversion, 0)
  )
  INTO v_costo_promedio
  FROM materias_primas
  WHERE insumo_id = p_insumo_id
    AND activa = TRUE
    AND deleted_at IS NULL
    AND precio_actual IS NOT NULL
    AND precio_actual > 0;

  IF v_costo_promedio IS NOT NULL THEN
    UPDATE insumos
      SET costo_actual = ROUND(v_costo_promedio::numeric, 2),
          costo_actualizado_at = NOW(),
          updated_at = NOW()
      WHERE id = p_insumo_id;
  END IF;
END;
$function$;

-- ── Marcar la columna como deprecada (sigue existiendo por compatibilidad) ──
COMMENT ON COLUMN materias_primas.merma_pct IS
  'DEPRECADO 2026-06-13 (migración 202606131100). La merma/rendimiento es UNA '
  'sola casa: receta_insumos.merma_pct (la línea de receta). Esta columna ya '
  'NO afecta el costo del insumo, que es as-bought = precio_actual/factor_conversion. '
  'Se mantiene por compatibilidad de datos; no usar en nuevas cargas (el form de '
  'PASE ya no la pide).';

NOTIFY pgrst, 'reload schema';
