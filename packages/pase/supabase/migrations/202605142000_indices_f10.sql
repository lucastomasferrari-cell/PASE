-- ═══════════════════════════════════════════════════════════════════════════
-- F10 — Índices faltantes en tablas grandes (decidido 2026-05-12).
--
-- Auditoría: el frontend filtra por estas columnas en listados frecuentes,
-- pero no había índice (Postgres no autocrea sobre FK ni sobre booleanos).
-- Sin índice, queries hacen seq scan de la tabla completa — duele cuando el
-- histórico crece. Costo: ~1-5 MB por índice + overhead marginal en
-- INSERT/UPDATE/DELETE. Trade-off claramente positivo para 1+ año.
--
-- Los listados básicos por (tenant_id, local_id, fecha) ya están cubiertos
-- por idx_*_tenant_local_fecha (migration 202605112100). Esta migration
-- agrega los que faltan.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) movimientos.anulado — filtro .eq("anulado", false) en cada listado de
--    Caja/Tesorería. Índice parcial: solo indexa filas activas (la mayoría),
--    optimiza el caso default.
CREATE INDEX IF NOT EXISTS idx_movimientos_anulado_false
  ON movimientos(anulado)
  WHERE anulado = false;

-- 2) facturas.prov_id — FK sin índice (Postgres no autocrea sobre FK).
--    Filtros frecuentes desde Compras/Proveedores/LectorIA al cargar factura.
CREATE INDEX IF NOT EXISTS idx_facturas_prov_id
  ON facturas(prov_id);

-- 3) rrhh_liquidaciones.calculado_at — range query .gte/.lte en Cierre y
--    EERR. Tabla crece N empleados × meses.
CREATE INDEX IF NOT EXISTS idx_rrhh_liquidaciones_calculado_at
  ON rrhh_liquidaciones(calculado_at DESC);

-- 4) auditoria(tabla, accion) — Caja.tsx queryea por
--    (tabla='movimientos', accion='EDICION'). Tabla append-only que crece
--    indefinidamente. Índice compuesto sirve para ambos filtros juntos y
--    para el caso de solo (tabla).
CREATE INDEX IF NOT EXISTS idx_auditoria_tabla_accion
  ON auditoria(tabla, accion);

-- 5) rrhh_liquidaciones.estado — .in("estado", ["pendiente","pagado"])
--    en Cierre y EERR. Estado tiene baja cardinalidad pero el filtro es
--    muy frecuente.
CREATE INDEX IF NOT EXISTS idx_rrhh_liquidaciones_estado
  ON rrhh_liquidaciones(estado);
