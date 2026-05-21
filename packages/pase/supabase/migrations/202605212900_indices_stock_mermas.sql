-- ═══════════════════════════════════════════════════════════════════════════
-- MED-12 Auditoría 2026-05-21: índices compuestos faltantes
--
-- Las tablas Stock tienen índices básicos pero faltan compuestos para los
-- reportes históricos más comunes:
--   - mermas (tenant_id, local_id, created_at) — reportes "mermas del mes"
--   - stock_conteos (local_id, fecha) — listado de conteos por local
-- Sin estos, las queries hacen full scan cuando hay historia grande.
--
-- IDEMPOTENTE: usa CREATE INDEX IF NOT EXISTS.
-- Verifica primero que la tabla tenga el column esperado (algunas tablas
-- pueden no existir en todos los entornos).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── insumo_movimientos: filtrado por (tenant, local, tipo, fecha) ────────
-- Aplica para reportes de mermas (tipo='merma'), CMV (tipo='salida_venta'),
-- traspasos (tipo='salida_traspaso'/'entrada_traspaso'), etc.
CREATE INDEX IF NOT EXISTS idx_insumo_mov_tenant_local_tipo_fecha
  ON insumo_movimientos (tenant_id, local_id, tipo, created_at DESC)
  WHERE deleted_at IS NULL;

-- ─── stock_conteos: filtrado por local + fecha ────────────────────────────
-- Para "todos los conteos del local X ordenados por fecha".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='stock_conteos') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_stock_conteos_local_fecha ON stock_conteos (local_id, created_at DESC) WHERE deleted_at IS NULL';
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ─── ig_eventos: filtrado por tenant + tipo + fecha ───────────────────────
-- Para "últimos errores del bot Instagram" — query común en Mensajería.
-- (Ya hay idx_ig_eventos_errores partial, pero no compuesto con tipo).
CREATE INDEX IF NOT EXISTS idx_ig_eventos_tenant_tipo_fecha
  ON ig_eventos (tenant_id, tipo, created_at DESC);

-- ─── ig_mensajes: filtrado por tenant + created_at ────────────────────────
-- Para MensajeriaIG dashboard que filtra mensajes recientes del tenant.
-- (Ya existe idx_ig_msgs_tenant_recent, este es duplicado-defensivo.)
CREATE INDEX IF NOT EXISTS idx_ig_msgs_tenant_origen_fecha
  ON ig_mensajes (tenant_id, origen, created_at DESC);

NOTIFY pgrst, 'reload schema';
