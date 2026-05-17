-- ═══════════════════════════════════════════════════════════════════════════
-- Objetivos mes — agregar costos fijos para cálculo de Punto de Equilibrio
-- Sesión 2026-05-17
--
-- Decisión de producto (Lucas, 2026-05-17): a mitad de mes los EERR mienten
-- porque los gastos fijos se pagan los primeros 15 días. Reemplazamos las
-- métricas mid-month "ingresos vs egresos" por **Punto de Equilibrio**:
--
--   BEP = costos_fijos_mes / margen_contribucion_pct
--
-- Necesitamos que el dueño cargue mes a mes:
--   - costos_fijos_mes: alquiler + sueldos fijos + servicios + cuotas etc.
--   - margen_contribucion_pct: % de cada peso vendido que queda después de
--     restar costos variables (CMV + delivery + comisiones MP). Default 50%
--     si nunca se setea — un piso razonable para gastronomía argentina.
--
-- Sobre el widget "Punto de Equilibrio": se compara con la facturación a
-- la fecha. Si facturado >= BEP → en zona de ganancia. Si no → cuánto falta
-- + cuántos días quedan.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE objetivos_mes
  ADD COLUMN IF NOT EXISTS costos_fijos_mes NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS margen_contribucion_pct NUMERIC(5,2) NULL;

COMMENT ON COLUMN objetivos_mes.costos_fijos_mes IS
  'Costos fijos esperados del mes (alquiler+sueldos fijos+servicios+cuotas). Insumo del cálculo de Punto de Equilibrio.';
COMMENT ON COLUMN objetivos_mes.margen_contribucion_pct IS
  '% de margen de contribución esperado (precio - costos variables) / precio. Insumo del BEP. Default visual 50%.';

NOTIFY pgrst, 'reload schema';
