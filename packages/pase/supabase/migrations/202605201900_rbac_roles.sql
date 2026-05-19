-- ═══════════════════════════════════════════════════════════════════════════
-- Sistema RBAC (Role-Based Access Control)
--
-- Lucas 2026-05-19: en vez de asignar permisos uno por uno a cada usuario,
-- definimos ROLES con sets de permisos pre-cargados. Al crear un usuario
-- nuevo, le asignás un rol y listo. Si necesitás algo distinto, creás un
-- rol custom para tu tenant.
--
-- Modelo:
--   - roles(id, tenant_id, slug, nombre, descripcion, es_sistema):
--     * tenant_id NULL = rol global del sistema (los 6 standard).
--     * tenant_id UUID = rol custom de ese tenant.
--     * es_sistema=true → no se puede borrar; se puede editar permisos.
--   - rol_permisos(rol_id, modulo_slug): permisos del rol.
--   - usuarios.rol_id: FK al rol asignado. Reemplaza usuario_permisos
--     gradualmente (tabla vieja se mantiene como fallback durante deprec).
--
-- Filosofía:
--   - TENÉS el permiso → hacés directo, sin código.
--   - NO TENÉS el permiso → la UI te abre modal pidiendo código TOTP del dueño.
--   - El dueño SIEMPRE tiene todos los permisos → nunca le piden código.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla roles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = global system role
  slug          TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  descripcion   TEXT,
  es_sistema    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- slug es único dentro del tenant (o globalmente para system roles).
  CONSTRAINT roles_slug_tenant_unique UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_roles_tenant ON roles (tenant_id);
CREATE INDEX IF NOT EXISTS idx_roles_es_sistema ON roles (es_sistema) WHERE es_sistema = true;

-- ─── 2. Tabla rol_permisos ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rol_permisos (
  rol_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  modulo_slug   TEXT NOT NULL,
  PRIMARY KEY (rol_id, modulo_slug)
);

CREATE INDEX IF NOT EXISTS idx_rol_permisos_modulo ON rol_permisos (modulo_slug);

-- ─── 3. Columna rol_id en usuarios ──────────────────────────────────────────
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS rol_id UUID REFERENCES roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_usuarios_rol_id ON usuarios (rol_id);

-- ─── 4. Trigger updated_at ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _roles_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_roles_updated_at ON roles;
CREATE TRIGGER trg_roles_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION _roles_updated_at();

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rol_permisos ENABLE ROW LEVEL SECURITY;

-- roles SELECT: cualquier authenticated ve roles del sistema (global) +
-- los de su tenant. Encargados también lo ven (necesario para mostrar el
-- nombre del rol de un usuario).
DROP POLICY IF EXISTS roles_select ON roles;
CREATE POLICY roles_select ON roles
  FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR tenant_id IS NULL
    OR tenant_id = auth_tenant_id()
  );

-- roles INSERT/UPDATE/DELETE: solo dueño/admin del tenant + superadmin.
-- Roles del sistema (es_sistema=true) solo superadmin los borra.
DROP POLICY IF EXISTS roles_insert ON roles;
CREATE POLICY roles_insert ON roles
  FOR INSERT TO authenticated
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin() AND es_sistema = false)
  );

DROP POLICY IF EXISTS roles_update ON roles;
CREATE POLICY roles_update ON roles
  FOR UPDATE TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS roles_delete ON roles;
CREATE POLICY roles_delete ON roles
  FOR DELETE TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin() AND es_sistema = false)
  );

-- rol_permisos: hereda la visibilidad del rol al que pertenece.
DROP POLICY IF EXISTS rol_permisos_select ON rol_permisos;
CREATE POLICY rol_permisos_select ON rol_permisos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = rol_permisos.rol_id
        AND (r.tenant_id IS NULL OR r.tenant_id = auth_tenant_id() OR auth_es_superadmin())
    )
  );

DROP POLICY IF EXISTS rol_permisos_insert ON rol_permisos;
CREATE POLICY rol_permisos_insert ON rol_permisos
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = rol_permisos.rol_id
        AND (
          auth_es_superadmin()
          OR (r.tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
        )
    )
  );

DROP POLICY IF EXISTS rol_permisos_delete ON rol_permisos;
CREATE POLICY rol_permisos_delete ON rol_permisos
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = rol_permisos.rol_id
        AND (
          auth_es_superadmin()
          OR (r.tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
        )
    )
  );

-- ─── 6. Seed: 6 roles del sistema ───────────────────────────────────────────
-- tenant_id = NULL → roles globales. Cada tenant los ve y puede asignar.
INSERT INTO roles (slug, nombre, descripcion, es_sistema, tenant_id) VALUES
  ('dueno',         'Dueño',         'Acceso total al sistema. Único que crea usuarios y maneja códigos manager.', true, NULL),
  ('socio',         'Socio',         'Solo lectura de información financiera (EERR, finanzas, cashflow). Sin acceso operativo.', true, NULL),
  ('administrador', 'Administrador', 'Operación diaria, RRHH e insumos. NO ve información financiera sensible.', true, NULL),
  ('encargado',     'Encargado',     'Carga gastos, ventas, caja y compras del día a día. Sin acciones destructivas.', true, NULL),
  ('cajero',        'Cajero',        'Cobra ventas y maneja caja del turno. Acceso mínimo.', true, NULL),
  ('contador',      'Contador',      'Acceso de solo lectura para contador externo: EERR, cierre, histórico.', true, NULL)
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ─── 7. Seed: permisos por rol según matriz aprobada ────────────────────────
DO $$
DECLARE
  v_dueno     UUID;
  v_socio     UUID;
  v_admin     UUID;
  v_encargado UUID;
  v_cajero    UUID;
  v_contador  UUID;
BEGIN
  SELECT id INTO v_dueno     FROM roles WHERE slug = 'dueno'         AND tenant_id IS NULL;
  SELECT id INTO v_socio     FROM roles WHERE slug = 'socio'         AND tenant_id IS NULL;
  SELECT id INTO v_admin     FROM roles WHERE slug = 'administrador' AND tenant_id IS NULL;
  SELECT id INTO v_encargado FROM roles WHERE slug = 'encargado'     AND tenant_id IS NULL;
  SELECT id INTO v_cajero    FROM roles WHERE slug = 'cajero'        AND tenant_id IS NULL;
  SELECT id INTO v_contador  FROM roles WHERE slug = 'contador'      AND tenant_id IS NULL;

  -- Dueño: TODOS los permisos conocidos del sistema (los descubrimos de
  -- la tabla usuario_permisos + slugs hardcoded en código).
  INSERT INTO rol_permisos (rol_id, modulo_slug)
  SELECT v_dueno, p FROM unnest(ARRAY[
    'dashboard','ventas','gastos','caja','compras','proveedores','remitos','mp',
    'compras_anular','ventas_anular','caja_anular',
    'eerr','cierre','finanzas','cashflow','negocio','objetivos',
    'costos','recetas','insumos',
    'ventas_historico','ver_anulados',
    'usuarios','configuracion','ajustes','blindaje',
    'rrhh','contador','ajustes_dashboards','codigos_manager'
  ]::text[]) AS p
  ON CONFLICT DO NOTHING;

  -- Socio: solo lectura financiera + dashboard. NO operativo.
  INSERT INTO rol_permisos (rol_id, modulo_slug)
  SELECT v_socio, p FROM unnest(ARRAY[
    'dashboard',
    'eerr','cierre','finanzas','cashflow','negocio','objetivos',
    'ventas_historico'
  ]::text[]) AS p
  ON CONFLICT DO NOTHING;

  -- Administrador: operativo + RRHH + insumos/recetas/costos. Sin anular,
  -- sin info financiera sensible, sin manage de usuarios.
  INSERT INTO rol_permisos (rol_id, modulo_slug)
  SELECT v_admin, p FROM unnest(ARRAY[
    'dashboard','ventas','gastos','caja','compras','proveedores','remitos','mp',
    'costos','recetas','insumos',
    'ventas_historico','ver_anulados',
    'configuracion','ajustes',
    'rrhh'
  ]::text[]) AS p
  ON CONFLICT DO NOTHING;

  -- Encargado: día a día. Carga sin anular. Sin info sensible.
  INSERT INTO rol_permisos (rol_id, modulo_slug)
  SELECT v_encargado, p FROM unnest(ARRAY[
    'dashboard','ventas','gastos','caja','compras','proveedores','remitos','mp',
    'insumos'
  ]::text[]) AS p
  ON CONFLICT DO NOTHING;

  -- Cajero: solo ventas + caja.
  INSERT INTO rol_permisos (rol_id, modulo_slug)
  SELECT v_cajero, p FROM unnest(ARRAY[
    'dashboard','ventas','caja'
  ]::text[]) AS p
  ON CONFLICT DO NOTHING;

  -- Contador: read-only financiero para contador externo.
  INSERT INTO rol_permisos (rol_id, modulo_slug)
  SELECT v_contador, p FROM unnest(ARRAY[
    'dashboard','eerr','cierre','contador',
    'ventas_historico','ver_anulados'
  ]::text[]) AS p
  ON CONFLICT DO NOTHING;
END $$;

-- ─── 8. Función auth_tiene_permiso reescrita ────────────────────────────────
-- Reemplaza la versión vieja que leía de usuario_permisos directamente.
-- Ahora lee de rol_permisos via usuarios.rol_id. Fallback a la tabla vieja
-- usuario_permisos durante deprecation (algunos users todavía no tienen
-- rol_id asignado).
CREATE OR REPLACE FUNCTION auth_tiene_permiso(p_slug TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_user RECORD;
  v_via_rol BOOLEAN;
  v_via_legacy BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;

  -- Superadmin tiene acceso a todo.
  IF auth_es_superadmin() THEN RETURN true; END IF;

  SELECT id, rol, rol_id, activo INTO v_user
  FROM usuarios WHERE auth_id = v_uid LIMIT 1;
  IF v_user IS NULL OR NOT v_user.activo THEN RETURN false; END IF;

  -- Dueño y admin con rol legacy = todos los permisos (bypass).
  IF v_user.rol IN ('dueno', 'admin') THEN RETURN true; END IF;

  -- Modelo nuevo: ¿tiene rol_id con ese permiso?
  IF v_user.rol_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM rol_permisos
      WHERE rol_id = v_user.rol_id AND modulo_slug = p_slug
    ) INTO v_via_rol;
    IF v_via_rol THEN RETURN true; END IF;
  END IF;

  -- Fallback legacy: ¿tiene el permiso en usuario_permisos?
  -- Mientras no migremos todos los users a rol_id, este fallback evita
  -- romper permisos existentes.
  SELECT EXISTS (
    SELECT 1 FROM usuario_permisos
    WHERE usuario_id = v_user.id AND modulo_slug = p_slug
  ) INTO v_via_legacy;
  RETURN v_via_legacy;
END;
$$;

GRANT EXECUTE ON FUNCTION auth_tiene_permiso(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
