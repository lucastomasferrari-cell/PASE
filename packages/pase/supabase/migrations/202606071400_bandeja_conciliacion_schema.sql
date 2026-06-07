-- 202606071400_bandeja_conciliacion_schema.sql
-- Pieza A — Bandeja conciliadora Compras→Insumos · Fase 0 (schema).
-- Spec: docs/superpowers/specs/2026-06-07-bandeja-conciliacion-compras-insumos-design.md
--
-- Agrega:
--   1. compras_mapeo: memoria de mapeo (proveedor + texto del producto) -> materia prima.
--      Permite el auto-match: la próxima factura con el mismo producto se auto-vincula.
--   2. factura_items.descartado_conciliacion: marcar un renglón como "no es insumo"
--      (propina, flete, redondeo) para que no vuelva a la bandeja.
--
-- NO toca el trigger de stock (la merma/rendimiento es decisión de la Pieza C).
-- Idempotente (IF NOT EXISTS).

-- ── 1. Tabla de memoria de mapeo ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compras_mapeo (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  -- NULL = mapeo "global" (vale para cualquier proveedor); si tiene valor, es
  -- específico de ese proveedor (default al resolver desde la bandeja).
  proveedor_id     integer REFERENCES proveedores(id),
  -- Texto del producto tal como viene en la factura, normalizado
  -- (lower + sin acentos + trim + espacios colapsados). Lo calcula el backend.
  texto_norm       text NOT NULL,
  materia_prima_id bigint NOT NULL REFERENCES materias_primas(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       integer REFERENCES usuarios(id)
);

-- Un (tenant, proveedor, texto) mapea a UNA sola materia prima.
-- proveedor_id NULL participa del unique (dos globales con mismo texto chocan).
CREATE UNIQUE INDEX IF NOT EXISTS compras_mapeo_uniq
  ON compras_mapeo (tenant_id, COALESCE(proveedor_id, 0), texto_norm);

-- Lookup rápido del auto-match.
CREATE INDEX IF NOT EXISTS compras_mapeo_lookup
  ON compras_mapeo (tenant_id, texto_norm);

-- RLS: lectura por tenant; escritura solo vía RPC SECURITY DEFINER (default deny).
ALTER TABLE compras_mapeo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compras_mapeo_select ON compras_mapeo;
CREATE POLICY compras_mapeo_select ON compras_mapeo
  FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id());

-- ── 2. Marcar renglón como "no es insumo" ─────────────────────────────────
ALTER TABLE factura_items
  ADD COLUMN IF NOT EXISTS descartado_conciliacion boolean NOT NULL DEFAULT false;

-- Índice parcial para listar pendientes de la bandeja rápido
-- (renglones de mercadería sin materia prima y no descartados).
CREATE INDEX IF NOT EXISTS factura_items_pendiente_conciliacion
  ON factura_items (tenant_id)
  WHERE materia_prima_id IS NULL AND descartado_conciliacion = false;

NOTIFY pgrst, 'reload schema';
