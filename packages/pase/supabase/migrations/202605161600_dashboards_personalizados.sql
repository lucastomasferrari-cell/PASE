-- ═══════════════════════════════════════════════════════════════════════════
-- Dashboards personalizados por rol — Sesión 2026-05-16
--
-- 3 tablas para que cada usuario tenga su dashboard de inicio con widgets
-- relevantes a su rol, customizable por el DUEÑO desde Settings.
--
-- Patrón: cada widget es un identificador string (ej. 'saldo_caja',
-- 'facturas_vencidas'). El registry de widgets vive client-side en
-- src/dashboards/registry.ts — cada widget define qué roles lo pueden ver,
-- cómo renderizarse, qué data fetchea, etc.
--
-- Tablas:
--   1. usuario_dashboard_config: qué widgets ve cada usuario + en qué orden
--      + config custom por widget (JSONB).
--   2. dashboard_pinned_notes: mensajes/tareas que el dueño pinea para un
--      usuario o rol específico (ej. "Juan: pedir descuento al proveedor X").
--   3. objetivos_mes: objetivos custom por mes (facturación, costos, etc).
--      Hoy useObjetivos() devuelve mock; con esta tabla se vuelve real.
--
-- Permiso de escritura: solo dueño/admin pueden modificar config de otros
-- usuarios. Cada usuario puede leer la suya (RLS).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. usuario_dashboard_config ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuario_dashboard_config (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  -- Array ordenado de IDs de widgets activos para este usuario.
  -- Ej: ["saldo_caja", "ventas_hoy", "alertas_operativas", "tareas_pineadas"]
  -- El orden importa — es el orden visual.
  widgets_activos JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Config específica por widget. Map de widget_id → opciones.
  -- Ej: { "ventas_hoy": { "comparar_contra": "ayer" } }
  widgets_config  JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Si TRUE, el usuario está usando el dashboard por default del rol
  -- (no fue customizado todavía). Permite saber cuándo refrescar defaults
  -- al cambiar el role o agregar widgets nuevos del sistema.
  es_default      BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT uniq_dashboard_por_usuario UNIQUE (usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_dash_config_tenant ON usuario_dashboard_config(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dash_config_usuario ON usuario_dashboard_config(usuario_id);

CREATE TRIGGER trg_dash_config_set_updated_at BEFORE UPDATE ON usuario_dashboard_config
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE usuario_dashboard_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dash_config_select ON usuario_dashboard_config;
CREATE POLICY dash_config_select ON usuario_dashboard_config FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (
      usuario_id = auth_usuario_id() OR auth_es_dueno_o_admin()
    ))
  );

DROP POLICY IF EXISTS dash_config_modify ON usuario_dashboard_config;
CREATE POLICY dash_config_modify ON usuario_dashboard_config FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS dash_config_service ON usuario_dashboard_config;
CREATE POLICY dash_config_service ON usuario_dashboard_config FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE usuario_dashboard_config IS
  'Config por usuario de qué widgets ve en su dashboard de inicio + orden + opciones. Modificable solo por dueño/admin. Sesión 2026-05-16.';

-- ─── 2. dashboard_pinned_notes ────────────────────────────────────────────
-- Notas/tareas que el dueño pinea para un usuario específico o todos los
-- usuarios de un rol. Visibles en el widget "Tareas pineadas" del dashboard.
CREATE TABLE IF NOT EXISTS dashboard_pinned_notes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id      INTEGER NULL REFERENCES locales(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INTEGER NOT NULL REFERENCES usuarios(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NULL,

  -- Target: usuario específico O un rol (uno o el otro, no ambos).
  target_usuario_id INTEGER NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  target_rol        TEXT NULL CHECK (
    target_rol IS NULL OR
    target_rol IN ('dueno', 'admin', 'encargado', 'compras', 'cajero')
  ),

  prioridad TEXT NOT NULL DEFAULT 'normal' CHECK (
    prioridad IN ('info', 'normal', 'alta', 'urgente')
  ),

  titulo TEXT NOT NULL CHECK (length(trim(titulo)) > 0),
  cuerpo TEXT NULL,

  -- Si tiene checkbox-style (tarea) o solo nota informativa.
  es_tarea BOOLEAN NOT NULL DEFAULT FALSE,
  -- Si es_tarea=TRUE: ¿quién la completó? (NULL = pendiente)
  completada_at  TIMESTAMPTZ NULL,
  completada_por INTEGER NULL REFERENCES usuarios(id),

  -- Exactly one target (usuario o rol)
  CONSTRAINT chk_one_target CHECK (
    (target_usuario_id IS NOT NULL AND target_rol IS NULL) OR
    (target_usuario_id IS NULL AND target_rol IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pinned_tenant ON dashboard_pinned_notes(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pinned_usuario ON dashboard_pinned_notes(target_usuario_id) WHERE target_usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pinned_rol ON dashboard_pinned_notes(target_rol) WHERE target_rol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pinned_pendientes ON dashboard_pinned_notes(tenant_id) WHERE completada_at IS NULL;

ALTER TABLE dashboard_pinned_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pinned_select ON dashboard_pinned_notes;
CREATE POLICY pinned_select ON dashboard_pinned_notes FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND (
      auth_es_dueno_o_admin()
      OR target_usuario_id = auth_usuario_id()
      OR target_rol = (SELECT rol FROM usuarios WHERE id = auth_usuario_id())
    ))
  );

DROP POLICY IF EXISTS pinned_modify ON dashboard_pinned_notes;
CREATE POLICY pinned_modify ON dashboard_pinned_notes FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS pinned_service ON dashboard_pinned_notes;
CREATE POLICY pinned_service ON dashboard_pinned_notes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE dashboard_pinned_notes IS
  'Notas/tareas pineadas por dueño/admin a un usuario o rol. Aparecen en widget "Tareas pineadas" del dashboard. Sesión 2026-05-16.';

-- ─── 3. objetivos_mes ─────────────────────────────────────────────────────
-- Objetivos del mes por local (facturación, costo de mercadería, ticket
-- promedio, margen). Hoy useObjetivos() devuelve mock; con esta tabla
-- se vuelve real. El dueño configura mes a mes.
CREATE TABLE IF NOT EXISTS objetivos_mes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id      INTEGER NULL REFERENCES locales(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INTEGER NULL REFERENCES usuarios(id),

  -- Mes objetivo: primer día del mes (ej. 2026-05-01 para Mayo 2026).
  mes DATE NOT NULL,

  -- Objetivos numéricos. NULL = sin objetivo seteado para esa métrica.
  facturacion_objetivo    NUMERIC(14,2) NULL,
  costo_mercaderia_pct    NUMERIC(5,2) NULL,  -- % objetivo CMV (ej. 32.00)
  ticket_promedio_objetivo NUMERIC(10,2) NULL,
  costo_mp_pct            NUMERIC(5,2) NULL,
  margen_bruto_pct        NUMERIC(5,2) NULL,

  -- Notas del dueño sobre el mes ("metas Q3", "campaña navidad", etc).
  notas TEXT NULL,

  CONSTRAINT uniq_objetivos_local_mes UNIQUE (local_id, mes)
);

CREATE INDEX IF NOT EXISTS idx_objetivos_tenant_mes ON objetivos_mes(tenant_id, mes DESC);
CREATE INDEX IF NOT EXISTS idx_objetivos_local ON objetivos_mes(local_id);

CREATE TRIGGER trg_objetivos_set_updated_at BEFORE UPDATE ON objetivos_mes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE objetivos_mes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS objetivos_select ON objetivos_mes;
CREATE POLICY objetivos_select ON objetivos_mes FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id IS NULL OR local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );

DROP POLICY IF EXISTS objetivos_modify ON objetivos_mes;
CREATE POLICY objetivos_modify ON objetivos_mes FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  );

DROP POLICY IF EXISTS objetivos_service ON objetivos_mes;
CREATE POLICY objetivos_service ON objetivos_mes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE objetivos_mes IS
  'Objetivos del mes por local (facturación, CMV, ticket prom, margen). Reemplaza el mock de useObjetivos(). Sesión 2026-05-16.';

NOTIFY pgrst, 'reload schema';
