-- ═══════════════════════════════════════════════════════════════════════════
-- F1.3 — Tabla rol_pos_permisos formal (formaliza el mapping hardcoded)
--
-- Detectado en auditoría estructural 2026-05-15: el mapping rol_pos → slugs
-- vive en `packages/comanda/src/lib/usePermiso.ts` como objeto literal
-- TypeScript. Cualquier cambio = deploy de frontend. Bloquea SaaS multi-tenant
-- donde los clientes quieran ajustar permisos.
--
-- Solución F1.3:
--   1. Tabla `rol_pos_permisos` (rol_pos, slug, activo). UNIQUE (rol_pos, slug).
--   2. Seed con el mapping actual (los 4 roles existentes + 'bartender' vacío
--      preparado).
--   3. RLS: lectura abierta a authenticated (el frontend cachea por sesión).
--   4. El frontend (packages/comanda/src/lib/usePermiso.ts) cambia de leer
--      objeto literal a query Supabase con cache sessionStorage. Mismo
--      patrón que useCategorias / useMediosCobro.
--
-- DESPUÉS de esta migration el mapping es runtime — Lucas/cliente puede
-- agregar/quitar slugs por rol desde UI futura.
-- ═══════════════════════════════════════════════════════════════════════════

-- Permite que el CHECK de rrhh_empleados.rol_pos acepte 'bartender'
-- (spec funcional Toast menciona 5 roles, schema actual tiene 4).
-- Bartender queda creado pero sin permisos asignados — Lucas decide
-- si activarlo y con qué slugs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'rrhh_empleados_rol_pos_check'
  ) THEN
    ALTER TABLE rrhh_empleados DROP CONSTRAINT rrhh_empleados_rol_pos_check;
  END IF;
END $$;
ALTER TABLE rrhh_empleados
  ADD CONSTRAINT rrhh_empleados_rol_pos_check
  CHECK (rol_pos IS NULL OR rol_pos IN ('cajero', 'encargado', 'manager', 'dueno', 'bartender'));

-- ─── Tabla rol_pos_permisos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rol_pos_permisos (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  -- Por ahora global (mismo mapping para todos los tenants). Si en el futuro
  -- queremos que cada tenant edite su matriz, agregamos `tenant_id NULL` y
  -- la regla pasa a "buscar override del tenant, fallback al global".
  rol_pos       TEXT NOT NULL CHECK (rol_pos IN ('cajero', 'encargado', 'manager', 'dueno', 'bartender')),
  slug          TEXT NOT NULL,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT uniq_rol_pos_slug UNIQUE (rol_pos, slug)
);

CREATE INDEX IF NOT EXISTS idx_rol_pos_permisos_rol
  ON rol_pos_permisos(rol_pos) WHERE activo = TRUE;

CREATE TRIGGER trg_rol_pos_permisos_set_updated_at BEFORE UPDATE ON rol_pos_permisos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE rol_pos_permisos IS
  'F1.3 (2026-05-15): mapping rol_pos → slugs. Reemplaza al objeto literal hardcoded en usePermiso.ts. UNIQUE(rol_pos, slug). dueno tiene slug "*" como wildcard.';

-- ─── RLS dual ──────────────────────────────────────────────────────────────
ALTER TABLE rol_pos_permisos ENABLE ROW LEVEL SECURITY;

-- Lectura abierta a authenticated (todos los empleados pueden saber qué
-- permisos tiene su rol_pos).
DROP POLICY IF EXISTS rol_pos_permisos_select ON rol_pos_permisos;
CREATE POLICY rol_pos_permisos_select ON rol_pos_permisos FOR SELECT TO authenticated
  USING (true);
-- Lectura abierta a anon también (no expone nada sensible — solo el mapping).
DROP POLICY IF EXISTS rol_pos_permisos_select_anon ON rol_pos_permisos;
CREATE POLICY rol_pos_permisos_select_anon ON rol_pos_permisos FOR SELECT TO anon
  USING (true);
-- Modificación: solo superadmin (cambios de matriz son operación crítica).
DROP POLICY IF EXISTS rol_pos_permisos_modify ON rol_pos_permisos;
CREATE POLICY rol_pos_permisos_modify ON rol_pos_permisos FOR ALL TO authenticated
  USING (auth_es_superadmin())
  WITH CHECK (auth_es_superadmin());
DROP POLICY IF EXISTS rol_pos_permisos_service ON rol_pos_permisos;
CREATE POLICY rol_pos_permisos_service ON rol_pos_permisos FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── Seed con mapping actual de usePermiso.ts ─────────────────────────────
-- cajero: ventas básicas + reportes.
INSERT INTO rol_pos_permisos (rol_pos, slug) VALUES
  ('cajero', 'comanda.ventas.cobrar'),
  ('cajero', 'comanda.reportes.ver')
ON CONFLICT (rol_pos, slug) DO NOTHING;

-- encargado: cajero + descuento + salon/clientes/pagos/empleados/catalogo ver.
INSERT INTO rol_pos_permisos (rol_pos, slug) VALUES
  ('encargado', 'comanda.ventas.cobrar'),
  ('encargado', 'comanda.ventas.descuento'),
  ('encargado', 'comanda.reportes.ver'),
  ('encargado', 'comanda.salon.editar'),
  ('encargado', 'comanda.clientes.ver'),
  ('encargado', 'comanda.pagos.ver'),
  ('encargado', 'comanda.empleados.ver'),
  ('encargado', 'comanda.catalogo.ver')
ON CONFLICT (rol_pos, slug) DO NOTHING;

-- manager: control total operacional, sin tocar suscripción ni superadmin.
INSERT INTO rol_pos_permisos (rol_pos, slug) VALUES
  ('manager', 'comanda.ventas.cobrar'),
  ('manager', 'comanda.ventas.descuento'),
  ('manager', 'comanda.ventas.anular'),
  ('manager', 'comanda.config.editar'),
  ('manager', 'comanda.configuracion.editar'),
  ('manager', 'comanda.catalogo.ver'),
  ('manager', 'comanda.catalogo.editar'),
  ('manager', 'comanda.empleados.ver'),
  ('manager', 'comanda.empleados.editar'),
  ('manager', 'comanda.empleados.editar_pos'),
  ('manager', 'comanda.salon.editar'),
  ('manager', 'comanda.pagos.ver'),
  ('manager', 'comanda.pagos.editar'),
  ('manager', 'comanda.online.gestionar'),
  ('manager', 'comanda.tienda.aprobar'),
  ('manager', 'comanda.reportes.ver'),
  ('manager', 'comanda.hardware.gestionar'),
  ('manager', 'comanda.marketing.gestionar'),
  ('manager', 'comanda.clientes.ver'),
  ('manager', 'comanda.clientes.editar'),
  ('manager', 'comanda.integraciones.gestionar')
ON CONFLICT (rol_pos, slug) DO NOTHING;

-- dueno: wildcard.
INSERT INTO rol_pos_permisos (rol_pos, slug) VALUES
  ('dueno', '*')
ON CONFLICT (rol_pos, slug) DO NOTHING;

-- bartender: seeded SIN permisos. Lucas/dueño decide qué slugs activar
-- (típicamente: ventas cobrar para cobrar en barra, sin descuentos).
-- Si se deja vacío, bartender no puede hacer nada — pero el constraint
-- ya acepta 'bartender' como valor en rrhh_empleados.rol_pos.

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN F1.3 — Después de esta migration, el frontend (usePermiso.ts) puede
-- migrar de objeto literal a query Supabase con cache sessionStorage.
-- ═══════════════════════════════════════════════════════════════════════════
