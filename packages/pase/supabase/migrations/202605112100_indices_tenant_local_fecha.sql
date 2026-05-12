-- ═══════════════════════════════════════════════════════════════════════════
-- F10 oportunistas — Índices compuestos (tenant_id, local_id, fecha DESC).
--
-- Hoy las tablas calientes (movimientos, ventas, facturas, gastos,
-- mp_movimientos) tienen índices base por (tenant_id) y (tenant_id,
-- local_id), pero las queries de PASE TÍPICAMENTE filtran por las 3
-- columnas: tenant + local activo + rango fecha.
--
-- Postgres puede usar el índice (tenant, local) y filtrar fecha en
-- memoria, pero a medida que crece el histórico (~1-2 años de operación
-- con 5 locales activos), eso se vuelve más caro. Estos índices son
-- preventivos y baratos en espacio (~5-10 MB total).
--
-- CREATE INDEX IF NOT EXISTS es idempotente — re-correr la migration es
-- safe. fecha DESC porque las queries ordenan "más reciente primero".
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_movimientos_tenant_local_fecha
  ON movimientos(tenant_id, local_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_ventas_tenant_local_fecha
  ON ventas(tenant_id, local_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_facturas_tenant_local_fecha
  ON facturas(tenant_id, local_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_gastos_tenant_local_fecha
  ON gastos(tenant_id, local_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_mp_movimientos_tenant_local_fecha
  ON mp_movimientos(tenant_id, local_id, fecha DESC);
