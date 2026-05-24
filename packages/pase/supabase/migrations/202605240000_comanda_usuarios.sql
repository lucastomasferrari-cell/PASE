-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint COMANDA Autónomo — Fase 1: schema de usuarios propio
--
-- Lucas 2026-05-24: COMANDA y PASE pasan a ser 2 sistemas autónomos
-- complementarios. Comparten Supabase Auth (un solo auth.users por email/
-- password) pero cada sistema tiene su propia tabla de perfiles + permisos.
--
-- Esta migration es ADITIVA: NO toca `usuarios` ni `usuario_permisos` de
-- PASE. Solo agrega 2 tablas nuevas:
--   - comanda_usuarios (perfil POS por tenant)
--   - comanda_usuario_permisos (slugs POS por user)
--
-- COMANDA puede seguir funcionando con la sesión heredada de PASE durante
-- la transición (Fase 3 cambia el login). Esta fase 1 NO rompe nada.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tabla comanda_usuarios ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comanda_usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK a auth.users (Supabase Auth compartido con PASE). Un mismo auth_id
  -- puede tener fila en `usuarios` (PASE) y/o en `comanda_usuarios` (POS).
  -- Si tiene en ambas, el mismo email+password loguea en los 2 sistemas
  -- pero con perfiles/permisos distintos por cada uno.
  auth_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  tenant_id UUID NOT NULL DEFAULT auth_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,

  nombre TEXT NOT NULL,
  email TEXT NOT NULL,

  -- Rol POS: mozo (solo abre/agrega items), cajero (cobra + conteo),
  -- manager (override + anular + descuentos), admin (configura items/recetas).
  rol_pos TEXT NOT NULL DEFAULT 'cajero' CHECK (rol_pos IN ('mozo', 'cajero', 'manager', 'admin')),

  -- Locales a los que tiene acceso. NULL = todos los del tenant.
  locales INTEGER[],

  -- PIN numérico opcional para acceso rápido al POS sin password completo
  -- (típico POS: usuario ya logueado en el dispositivo, cambian de operario
  -- con PIN de 4-6 dígitos). El password sigue siendo el de auth.users.
  pin_pos TEXT,

  activo BOOLEAN NOT NULL DEFAULT true,

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unicidad: un mismo email no puede tener 2 perfiles en el mismo tenant
  UNIQUE (tenant_id, email),
  -- Un auth_id puede tener UNA fila por tenant
  UNIQUE (tenant_id, auth_id)
);

CREATE INDEX IF NOT EXISTS idx_comanda_usuarios_tenant ON comanda_usuarios(tenant_id);
CREATE INDEX IF NOT EXISTS idx_comanda_usuarios_auth ON comanda_usuarios(auth_id);

-- ─── 2. Tabla comanda_usuario_permisos ───────────────────────────────────
CREATE TABLE IF NOT EXISTS comanda_usuario_permisos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comanda_usuario_id UUID NOT NULL REFERENCES comanda_usuarios(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL DEFAULT auth_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  modulo_slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comanda_usuario_id, modulo_slug)
);

CREATE INDEX IF NOT EXISTS idx_comanda_permisos_user ON comanda_usuario_permisos(comanda_usuario_id);
CREATE INDEX IF NOT EXISTS idx_comanda_permisos_tenant ON comanda_usuario_permisos(tenant_id);

-- ─── 3. RLS dual (mismo patrón que PASE) ─────────────────────────────────
ALTER TABLE comanda_usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE comanda_usuario_permisos ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquier user autenticado del mismo tenant lo ve.
-- Esto permite al frontend de PASE (admin) listar comanda_usuarios.
DROP POLICY IF EXISTS comanda_usuarios_select ON comanda_usuarios;
CREATE POLICY comanda_usuarios_select ON comanda_usuarios
  FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id());

-- INSERT/UPDATE/DELETE: solo dueño/admin/superadmin del mismo tenant.
DROP POLICY IF EXISTS comanda_usuarios_modify ON comanda_usuarios;
CREATE POLICY comanda_usuarios_modify ON comanda_usuarios
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_es_superadmin()))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_es_superadmin()));

DROP POLICY IF EXISTS comanda_permisos_select ON comanda_usuario_permisos;
CREATE POLICY comanda_permisos_select ON comanda_usuario_permisos
  FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS comanda_permisos_modify ON comanda_usuario_permisos;
CREATE POLICY comanda_permisos_modify ON comanda_usuario_permisos
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_es_superadmin()))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR auth_es_superadmin()));

-- ─── 4. Catálogo de slugs POS (referencia para el frontend) ──────────────
-- Tabla globally readable con los slugs disponibles + descripción.
-- Sirve para que la UI de "crear usuario COMANDA" muestre checkboxes con
-- labels en español y que el código no se quede sin un slug nuevo cuando
-- agreguemos features.
CREATE TABLE IF NOT EXISTS comanda_permisos_catalogo (
  slug TEXT PRIMARY KEY,
  descripcion TEXT NOT NULL,
  categoria TEXT NOT NULL,  -- 'ventas', 'mesas', 'items', 'inventario', 'cierre', 'admin'
  orden INT NOT NULL DEFAULT 100
);

INSERT INTO comanda_permisos_catalogo (slug, descripcion, categoria, orden) VALUES
  ('comanda.ventas.abrir',       'Abrir mesa y agregar items',                    'ventas', 10),
  ('comanda.ventas.cobrar',      'Cobrar venta (efectivo / tarjeta / MP)',        'ventas', 20),
  ('comanda.ventas.anular',      'Anular venta entera',                           'ventas', 30),
  ('comanda.ventas.descuento',   'Aplicar descuento ≤15% del total',              'ventas', 40),
  ('comanda.items.cortesia',     'Marcar item como cortesía',                     'items',  10),
  ('comanda.items.precio',       'Modificar precio de un item',                   'items',  20),
  ('comanda.items.anular',       'Anular item de la venta',                       'items',  30),
  ('comanda.mesas.transferir',   'Transferir venta a otra mesa',                  'mesas',  10),
  ('comanda.mesas.unir',         'Unir 2 mesas en 1 venta',                       'mesas',  20),
  ('comanda.mesas.partir',       'Partir cuenta en múltiples ventas',             'mesas',  30),
  ('comanda.inventario.conteo',  'Realizar conteo ciego de stock',                'inventario', 10),
  ('comanda.inventario.merma',   'Registrar merma o robo (con TOTP override)',    'inventario', 20),
  ('comanda.cierre.realizar',    'Realizar cierre de turno + arqueo',             'cierre', 10),
  ('comanda.admin.items',        'Configurar items, recetas, precios canal',      'admin',  10),
  ('comanda.admin.empleados',    'Gestionar usuarios POS',                        'admin',  20)
ON CONFLICT (slug) DO NOTHING;

-- ─── 5. Helper: comanda_auth_tiene_permiso(slug) ─────────────────────────
-- Análogo a auth_tiene_permiso pero contra comanda_usuario_permisos.
-- Las RPCs de COMANDA pueden usarlo en lugar de chequear contra usuario_permisos.
CREATE OR REPLACE FUNCTION comanda_auth_tiene_permiso(p_slug TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth uuid := auth.uid();
  v_tenant uuid := auth_tenant_id();
  v_usuario_id uuid;
  v_rol_pos TEXT;
  v_existe BOOLEAN;
BEGIN
  IF v_auth IS NULL OR v_tenant IS NULL THEN RETURN false; END IF;

  -- Buscar comanda_usuario por auth_id + tenant
  SELECT id, rol_pos INTO v_usuario_id, v_rol_pos
  FROM comanda_usuarios
  WHERE auth_id = v_auth AND tenant_id = v_tenant AND activo = true;

  IF v_usuario_id IS NULL THEN RETURN false; END IF;

  -- Admin POS = todo
  IF v_rol_pos = 'admin' THEN RETURN true; END IF;

  -- Chequear slug específico
  SELECT EXISTS(
    SELECT 1 FROM comanda_usuario_permisos
    WHERE comanda_usuario_id = v_usuario_id AND modulo_slug = p_slug
  ) INTO v_existe;

  RETURN COALESCE(v_existe, false);
END;
$$;

REVOKE ALL ON FUNCTION comanda_auth_tiene_permiso(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION comanda_auth_tiene_permiso(TEXT) TO authenticated;

-- ─── 6. Helper: comanda_auth_usuario_id() ────────────────────────────────
-- Retorna el id del comanda_usuario del auth.uid() actual.
CREATE OR REPLACE FUNCTION comanda_auth_usuario_id()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth uuid := auth.uid();
  v_tenant uuid := auth_tenant_id();
  v_id uuid;
BEGIN
  IF v_auth IS NULL OR v_tenant IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM comanda_usuarios
  WHERE auth_id = v_auth AND tenant_id = v_tenant AND activo = true;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION comanda_auth_usuario_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION comanda_auth_usuario_id() TO authenticated;

-- ─── 7. updated_at trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION comanda_usuarios_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comanda_usuarios_updated_at ON comanda_usuarios;
CREATE TRIGGER trg_comanda_usuarios_updated_at
BEFORE UPDATE ON comanda_usuarios
FOR EACH ROW EXECUTE FUNCTION comanda_usuarios_touch_updated_at();

NOTIFY pgrst, 'reload schema';
