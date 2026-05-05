-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 1 — Schema base + Catálogo Unificado + Canales + Precios
--
-- Crea:
--   - Extensiones pg_trgm, unaccent.
--   - Helper fn_set_updated_at() (no existía en PASE).
--   - 12 tablas de catálogo: tax_rates, item_grupos, items, canales,
--     item_precios_canal, modifier_groups, modifiers, item_modifier_groups,
--     combo_componentes, recetas_versiones, items_history,
--     item_precios_canal_history, canales_history.
--   - RLS multi-tenant canónica PASE (auth_es_superadmin OR ...) en todas.
--   - Triggers de updated_at + auditoría en items, item_precios_canal, canales.
--   - RPCs: fn_aumento_masivo_precios, fn_marcar_agotado_comanda.
--   - Seeds idempotentes (tax_rates + canales) resueltos contra tenant 'neko'.
--
-- Decisiones (confirmadas con el usuario):
--   - Tenant resuelto en runtime: SELECT id FROM tenants WHERE slug='neko'.
--     NO se usa el UUID hardcodeado del prompt (no existía en la DB).
--   - Tabla `permisos` NO existe en PASE; los slugs nuevos
--     (comanda.catalogo.ver/editar/eliminar, comanda.canales.ver/editar,
--     comanda.precios.editar, comanda.precios.aumento_masivo,
--     comanda.modifiers.editar, comanda.tax.editar) viven solo en las
--     policies. Asignación per-user se hace después con
--     INSERT INTO usuario_permisos (usuario_id, modulo_slug).
--   - Patrón RLS canónico de PASE: auth_es_superadmin() OR (tenant_id +
--     dueño/admin OR locales visibles) AND deleted_at IS NULL en SELECT,
--     auth_tiene_permiso(slug) adicional en INSERT/UPDATE WITH CHECK.
--   - Auth helper auth_usuario_id() ya existe; se reusa en RPCs.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extensiones ────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ─── 2. Helper updated_at (no existía en PASE) ─────────────────────────────
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Wrapper IMMUTABLE de unaccent. La unaccent() del extension es STABLE
-- (depende del diccionario), por eso no se puede usar directo en índices.
-- Usamos la firma de 2 args (regdictionary, text) que sí está disponible.
CREATE OR REPLACE FUNCTION fn_unaccent_immutable(text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLAS
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 3. tax_rates ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_rates (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  nombre        TEXT NOT NULL,
  porcentaje    NUMERIC(5,2) NOT NULL,
  es_default    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_tax_rates_tenant
  ON tax_rates(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_rates_default_per_tenant
  ON tax_rates(tenant_id) WHERE es_default = TRUE AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_tax_rates_set_updated_at ON tax_rates;
CREATE TRIGGER trg_tax_rates_set_updated_at
  BEFORE UPDATE ON tax_rates FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 4. item_grupos ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_grupos (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  nombre        TEXT NOT NULL,
  color         TEXT NULL,
  emoji         TEXT NULL,
  orden         INTEGER NOT NULL DEFAULT 0,

  tax_rate_id   INTEGER NULL REFERENCES tax_rates(id),
  estacion_default TEXT NULL CHECK (
    estacion_default IS NULL OR
    estacion_default IN ('cocina_caliente', 'cocina_fria', 'barra', 'postres')
  )
);

CREATE INDEX IF NOT EXISTS idx_item_grupos_tenant_local
  ON item_grupos(tenant_id, local_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_item_grupos_nombre_per_local
  ON item_grupos (tenant_id, COALESCE(local_id, 0), LOWER(fn_unaccent_immutable(nombre)))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_item_grupos_set_updated_at ON item_grupos;
CREATE TRIGGER trg_item_grupos_set_updated_at
  BEFORE UPDATE ON item_grupos FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 5. items ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  nombre        TEXT NOT NULL,
  descripcion   TEXT NULL,
  emoji         TEXT NULL,
  foto_url      TEXT NULL,
  codigo        TEXT NULL,

  grupo_id      INTEGER NULL REFERENCES item_grupos(id),
  orden         INTEGER NOT NULL DEFAULT 0,

  precio_madre  NUMERIC(12,2) NOT NULL DEFAULT 0,

  costo_actual         NUMERIC(12,2) NULL,
  costo_actualizado_at TIMESTAMPTZ NULL,

  receta_version_id_vigente  BIGINT NULL,

  tax_rate_id   INTEGER NULL REFERENCES tax_rates(id),
  estacion      TEXT NULL CHECK (
    estacion IS NULL OR
    estacion IN ('cocina_caliente', 'cocina_fria', 'barra', 'postres')
  ),

  estado        TEXT NOT NULL DEFAULT 'disponible'
                CHECK (estado IN ('disponible', 'agotado', 'inactivo')),
  agotado_motivo TEXT NULL,
  agotado_por    INTEGER NULL REFERENCES usuarios(id),
  agotado_at     TIMESTAMPTZ NULL,
  agotado_hasta  TIMESTAMPTZ NULL,

  es_combo      BOOLEAN NOT NULL DEFAULT FALSE,

  visible_pos       BOOLEAN NOT NULL DEFAULT TRUE,
  visible_qr        BOOLEAN NOT NULL DEFAULT TRUE,
  visible_tienda    BOOLEAN NOT NULL DEFAULT TRUE,

  es_open_item  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_items_tenant_local
  ON items(tenant_id, local_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_grupo
  ON items(grupo_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_estado
  ON items(tenant_id, estado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_nombre_trgm
  ON items USING gin (nombre gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_items_nombre_per_local
  ON items (tenant_id, COALESCE(local_id, 0), LOWER(fn_unaccent_immutable(nombre)))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_items_set_updated_at ON items;
CREATE TRIGGER trg_items_set_updated_at
  BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 6. canales ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canales (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  nombre        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  emoji         TEXT NULL,
  color         TEXT NULL,

  modo_pos      TEXT NOT NULL CHECK (modo_pos IN ('salon', 'mostrador', 'pedidos')),

  atado_madre        BOOLEAN NOT NULL DEFAULT TRUE,
  ajuste_madre_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
  comision_externa_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  redondeo_a    INTEGER NOT NULL DEFAULT 1,

  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  grupo         TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_canales_tenant_local
  ON canales(tenant_id, local_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_canales_slug_per_local
  ON canales (tenant_id, COALESCE(local_id, 0), slug)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_canales_set_updated_at ON canales;
CREATE TRIGGER trg_canales_set_updated_at
  BEFORE UPDATE ON canales FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 7. item_precios_canal ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_precios_canal (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  item_id       INTEGER NOT NULL REFERENCES items(id),
  canal_id      INTEGER NOT NULL REFERENCES canales(id),

  precio        NUMERIC(12,2) NOT NULL,
  edicion_manual BOOLEAN NOT NULL DEFAULT FALSE,
  vendible      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_ipc_item
  ON item_precios_canal(item_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ipc_canal
  ON item_precios_canal(canal_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_item_precio_canal
  ON item_precios_canal (item_id, canal_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_ipc_set_updated_at ON item_precios_canal;
CREATE TRIGGER trg_ipc_set_updated_at
  BEFORE UPDATE ON item_precios_canal FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 8. modifier_groups ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modifier_groups (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  local_id      INTEGER NULL REFERENCES locales(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  nombre        TEXT NOT NULL,
  descripcion   TEXT NULL,

  requerido     BOOLEAN NOT NULL DEFAULT FALSE,
  min_seleccion INTEGER NOT NULL DEFAULT 0,
  max_seleccion INTEGER NULL,

  tipo          TEXT NOT NULL DEFAULT 'opcion'
                CHECK (tipo IN ('opcion', 'extra', 'aclaracion', 'sin_con')),

  CONSTRAINT chk_min_max CHECK (max_seleccion IS NULL OR max_seleccion >= min_seleccion)
);

CREATE INDEX IF NOT EXISTS idx_modifier_groups_tenant
  ON modifier_groups(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_modifier_groups_nombre_per_local
  ON modifier_groups (tenant_id, COALESCE(local_id, 0), LOWER(fn_unaccent_immutable(nombre)))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_modifier_groups_set_updated_at ON modifier_groups;
CREATE TRIGGER trg_modifier_groups_set_updated_at
  BEFORE UPDATE ON modifier_groups FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 9. modifiers ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modifiers (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  modifier_group_id  INTEGER NOT NULL REFERENCES modifier_groups(id),

  nombre        TEXT NOT NULL,
  precio_extra  NUMERIC(12,2) NOT NULL DEFAULT 0,
  orden         INTEGER NOT NULL DEFAULT 0,

  receta_modifier_id  BIGINT NULL,

  activo        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_modifiers_group
  ON modifiers(modifier_group_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_modifiers_set_updated_at ON modifiers;
CREATE TRIGGER trg_modifiers_set_updated_at
  BEFORE UPDATE ON modifiers FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 10. item_modifier_groups ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_modifier_groups (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  item_id            INTEGER NOT NULL REFERENCES items(id),
  modifier_group_id  INTEGER NOT NULL REFERENCES modifier_groups(id),
  orden              INTEGER NOT NULL DEFAULT 0,

  requerido_override     BOOLEAN NULL,
  min_seleccion_override INTEGER NULL,
  max_seleccion_override INTEGER NULL,

  CONSTRAINT uniq_item_modifier_group UNIQUE (item_id, modifier_group_id)
);

CREATE INDEX IF NOT EXISTS idx_img_item ON item_modifier_groups(item_id);
CREATE INDEX IF NOT EXISTS idx_img_group ON item_modifier_groups(modifier_group_id);

-- ─── 11. combo_componentes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combo_componentes (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_by    INTEGER NULL REFERENCES usuarios(id),
  updated_by    INTEGER NULL REFERENCES usuarios(id),

  combo_id      INTEGER NOT NULL REFERENCES items(id),

  slot_nombre   TEXT NOT NULL,
  slot_orden    INTEGER NOT NULL DEFAULT 0,

  min_seleccion INTEGER NOT NULL DEFAULT 1,
  max_seleccion INTEGER NOT NULL DEFAULT 1,

  item_elegible_id INTEGER NOT NULL REFERENCES items(id),
  precio_extra     NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_combo_componentes_combo
  ON combo_componentes(combo_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_combo_componentes_item
  ON combo_componentes(item_elegible_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_combo_componentes_set_updated_at ON combo_componentes;
CREATE TRIGGER trg_combo_componentes_set_updated_at
  BEFORE UPDATE ON combo_componentes FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ─── 12. recetas_versiones (placeholder Ola 3, inmutable) ──────────────────
CREATE TABLE IF NOT EXISTS recetas_versiones (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INTEGER NULL REFERENCES usuarios(id),

  item_id       INTEGER NOT NULL REFERENCES items(id),
  version_numero INTEGER NOT NULL,
  receta_data   JSONB NOT NULL,
  notas         TEXT NULL,

  CONSTRAINT uniq_receta_version UNIQUE (item_id, version_numero)
);

CREATE INDEX IF NOT EXISTS idx_recetas_versiones_item
  ON recetas_versiones(item_id);

CREATE OR REPLACE FUNCTION fn_recetas_versiones_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'recetas_versiones es inmutable, no se puede modificar ni borrar';
END;
$$;

DROP TRIGGER IF EXISTS trg_recetas_versiones_no_update ON recetas_versiones;
CREATE TRIGGER trg_recetas_versiones_no_update
  BEFORE UPDATE OR DELETE ON recetas_versiones
  FOR EACH ROW EXECUTE FUNCTION fn_recetas_versiones_immutable();

-- FK pendiente desde items
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_receta_version'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT fk_items_receta_version
      FOREIGN KEY (receta_version_id_vigente) REFERENCES recetas_versiones(id);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- AUDITORÍA (history tables + triggers)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── items_history ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items_history (
  history_id    BIGSERIAL PRIMARY KEY,
  item_id       INTEGER NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('UPDATE', 'DELETE')),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by    INTEGER NULL REFERENCES usuarios(id),
  old_data      JSONB NOT NULL,
  new_data      JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_items_history_item
  ON items_history(item_id, changed_at DESC);

CREATE OR REPLACE FUNCTION fn_items_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO items_history (item_id, operation, changed_by, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_items_audit ON items;
CREATE TRIGGER trg_items_audit
  AFTER UPDATE ON items FOR EACH ROW EXECUTE FUNCTION fn_items_audit();

-- ─── item_precios_canal_history ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_precios_canal_history (
  history_id    BIGSERIAL PRIMARY KEY,
  ipc_id        INTEGER NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('UPDATE', 'DELETE')),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by    INTEGER NULL REFERENCES usuarios(id),
  old_data      JSONB NOT NULL,
  new_data      JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_ipc_history_id
  ON item_precios_canal_history(ipc_id, changed_at DESC);

CREATE OR REPLACE FUNCTION fn_ipc_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO item_precios_canal_history (ipc_id, operation, changed_by, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ipc_audit ON item_precios_canal;
CREATE TRIGGER trg_ipc_audit
  AFTER UPDATE ON item_precios_canal FOR EACH ROW EXECUTE FUNCTION fn_ipc_audit();

-- ─── canales_history ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canales_history (
  history_id    BIGSERIAL PRIMARY KEY,
  canal_id      INTEGER NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('UPDATE', 'DELETE')),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by    INTEGER NULL REFERENCES usuarios(id),
  old_data      JSONB NOT NULL,
  new_data      JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_canales_history_id
  ON canales_history(canal_id, changed_at DESC);

CREATE OR REPLACE FUNCTION fn_canales_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO canales_history (canal_id, operation, changed_by, old_data, new_data)
    VALUES (OLD.id, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_canales_audit ON canales;
CREATE TRIGGER trg_canales_audit
  AFTER UPDATE ON canales FOR EACH ROW EXECUTE FUNCTION fn_canales_audit();

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (patrón canónico PASE)
-- ═══════════════════════════════════════════════════════════════════════════
-- USING:    superadmin OR (mismo tenant + dueño/admin OR local visible OR local NULL)
--           AND deleted_at IS NULL (los soft-deleted desaparecen del SELECT).
-- INSERT/UPDATE WITH CHECK: idem + auth_tiene_permiso(slug correspondiente).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── tax_rates ─────────────────────────────────────────────────────────────
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tax_rates_select" ON tax_rates;
CREATE POLICY "tax_rates_select" ON tax_rates FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS "tax_rates_write" ON tax_rates;
CREATE POLICY "tax_rates_write" ON tax_rates FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.tax.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.tax.editar')
    )
  );

-- ─── item_grupos ───────────────────────────────────────────────────────────
ALTER TABLE item_grupos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "item_grupos_select" ON item_grupos;
CREATE POLICY "item_grupos_select" ON item_grupos FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS "item_grupos_write" ON item_grupos;
CREATE POLICY "item_grupos_write" ON item_grupos FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  );

-- ─── items ─────────────────────────────────────────────────────────────────
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "items_select" ON items;
CREATE POLICY "items_select" ON items FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS "items_write" ON items;
CREATE POLICY "items_write" ON items FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  );

-- ─── canales ───────────────────────────────────────────────────────────────
ALTER TABLE canales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "canales_select" ON canales;
CREATE POLICY "canales_select" ON canales FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS "canales_write" ON canales;
CREATE POLICY "canales_write" ON canales FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.canales.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.canales.editar')
    )
  );

-- ─── item_precios_canal ────────────────────────────────────────────────────
ALTER TABLE item_precios_canal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipc_select" ON item_precios_canal;
CREATE POLICY "ipc_select" ON item_precios_canal FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS "ipc_write" ON item_precios_canal;
CREATE POLICY "ipc_write" ON item_precios_canal FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.precios.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.precios.editar')
    )
  );

-- ─── modifier_groups ───────────────────────────────────────────────────────
ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "modifier_groups_select" ON modifier_groups;
CREATE POLICY "modifier_groups_select" ON modifier_groups FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR (
        tenant_id = auth_tenant_id() AND
        (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
      )
    )
  );
DROP POLICY IF EXISTS "modifier_groups_write" ON modifier_groups;
CREATE POLICY "modifier_groups_write" ON modifier_groups FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.modifiers.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND
      auth_tiene_permiso('comanda.modifiers.editar')
    )
  );

-- ─── modifiers (tabla hija de modifier_groups, no tiene local_id) ──────────
ALTER TABLE modifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "modifiers_select" ON modifiers;
CREATE POLICY "modifiers_select" ON modifiers FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR tenant_id = auth_tenant_id()
    )
  );
DROP POLICY IF EXISTS "modifiers_write" ON modifiers;
CREATE POLICY "modifiers_write" ON modifiers FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.modifiers.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.modifiers.editar')
    )
  );

-- ─── item_modifier_groups (N:M, sin local_id ni deleted_at) ────────────────
ALTER TABLE item_modifier_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "img_select" ON item_modifier_groups;
CREATE POLICY "img_select" ON item_modifier_groups FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());
DROP POLICY IF EXISTS "img_write" ON item_modifier_groups;
CREATE POLICY "img_write" ON item_modifier_groups FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  );

-- ─── combo_componentes (sin local_id) ──────────────────────────────────────
ALTER TABLE combo_componentes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "combo_componentes_select" ON combo_componentes;
CREATE POLICY "combo_componentes_select" ON combo_componentes FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      auth_es_superadmin() OR tenant_id = auth_tenant_id()
    )
  );
DROP POLICY IF EXISTS "combo_componentes_write" ON combo_componentes;
CREATE POLICY "combo_componentes_write" ON combo_componentes FOR ALL TO authenticated
  USING (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  )
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  );

-- ─── recetas_versiones (insert-only por trigger; sin local_id) ─────────────
ALTER TABLE recetas_versiones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recetas_versiones_select" ON recetas_versiones;
CREATE POLICY "recetas_versiones_select" ON recetas_versiones FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());
DROP POLICY IF EXISTS "recetas_versiones_insert" ON recetas_versiones;
CREATE POLICY "recetas_versiones_insert" ON recetas_versiones FOR INSERT TO authenticated
  WITH CHECK (
    auth_es_superadmin() OR (
      tenant_id = auth_tenant_id() AND
      auth_tiene_permiso('comanda.catalogo.editar')
    )
  );
-- UPDATE/DELETE bloqueados por trigger fn_recetas_versiones_immutable

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── fn_aumento_masivo_precios ─────────────────────────────────────────────
-- Sube precio_madre + recalcula todos los precios atados al madre.
-- Pisa edicion_manual=TRUE → FALSE (regla del prompt: aumento masivo
-- "pisa" la edición manual, manteniéndolos atados).
CREATE OR REPLACE FUNCTION fn_aumento_masivo_precios(
  p_tenant_id   UUID,
  p_local_id    INTEGER,
  p_grupo_id    INTEGER,
  p_porcentaje  NUMERIC,
  p_redondeo_a  INTEGER DEFAULT 1
)
RETURNS TABLE (
  items_afectados      INTEGER,
  precios_recalculados INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_items_count   INTEGER := 0;
  v_precios_count INTEGER := 0;
BEGIN
  IF NOT (auth_es_superadmin() OR auth_tiene_permiso('comanda.precios.aumento_masivo')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_AUMENTO_MASIVO';
  END IF;

  IF p_redondeo_a IS NULL OR p_redondeo_a < 1 THEN
    RAISE EXCEPTION 'REDONDEO_INVALIDO';
  END IF;

  -- 1) Subir precio_madre
  UPDATE items SET
    precio_madre = ROUND(precio_madre * (1 + p_porcentaje / 100.0) / p_redondeo_a) * p_redondeo_a,
    updated_at   = NOW(),
    updated_by   = auth_usuario_id()
  WHERE tenant_id = p_tenant_id
    AND (p_local_id IS NULL OR local_id = p_local_id OR local_id IS NULL)
    AND (p_grupo_id IS NULL OR grupo_id = p_grupo_id)
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_items_count = ROW_COUNT;

  -- 2) Recalcular precios atados (atado_madre TRUE en canal). Pisa edicion_manual.
  UPDATE item_precios_canal ipc SET
    precio = ROUND(
      i.precio_madre * (1 + c.ajuste_madre_pct / 100.0) / c.redondeo_a
    ) * c.redondeo_a,
    edicion_manual = FALSE,
    updated_at = NOW(),
    updated_by = auth_usuario_id()
  FROM items i, canales c
  WHERE ipc.item_id = i.id
    AND ipc.canal_id = c.id
    AND c.atado_madre = TRUE
    AND ipc.tenant_id = p_tenant_id
    AND (p_local_id IS NULL OR ipc.local_id = p_local_id OR ipc.local_id IS NULL)
    AND (p_grupo_id IS NULL OR i.grupo_id = p_grupo_id)
    AND ipc.deleted_at IS NULL;

  GET DIAGNOSTICS v_precios_count = ROW_COUNT;

  RETURN QUERY SELECT v_items_count, v_precios_count;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_aumento_masivo_precios(UUID, INTEGER, INTEGER, NUMERIC, INTEGER) TO authenticated;

-- ─── fn_marcar_agotado_comanda ─────────────────────────────────────────────
-- Sufijo _comanda para no colisionar con eventuales fn_marcar_agotado de otros módulos.
CREATE OR REPLACE FUNCTION fn_marcar_agotado_comanda(
  p_item_id     INTEGER,
  p_motivo      TEXT,
  p_hasta       TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NOT (auth_es_superadmin() OR auth_tiene_permiso('comanda.catalogo.editar')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_MARCAR_AGOTADO';
  END IF;

  UPDATE items SET
    estado         = 'agotado',
    agotado_motivo = p_motivo,
    agotado_por    = auth_usuario_id(),
    agotado_at     = NOW(),
    agotado_hasta  = p_hasta,
    updated_at     = NOW(),
    updated_by     = auth_usuario_id()
  WHERE id = p_item_id
    AND (auth_es_superadmin() OR tenant_id = auth_tenant_id())
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_ENCONTRADO';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_marcar_agotado_comanda(INTEGER, TEXT, TIMESTAMPTZ) TO authenticated;

-- ─── fn_marcar_disponible_comanda ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_marcar_disponible_comanda(p_item_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NOT (auth_es_superadmin() OR auth_tiene_permiso('comanda.catalogo.editar')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_MARCAR_DISPONIBLE';
  END IF;

  UPDATE items SET
    estado         = 'disponible',
    agotado_motivo = NULL,
    agotado_por    = NULL,
    agotado_at     = NULL,
    agotado_hasta  = NULL,
    updated_at     = NOW(),
    updated_by     = auth_usuario_id()
  WHERE id = p_item_id
    AND (auth_es_superadmin() OR tenant_id = auth_tenant_id())
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ITEM_NO_ENCONTRADO';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_marcar_disponible_comanda(INTEGER) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEEDS (idempotentes, resueltos contra tenant 'neko')
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tenant_id UUID;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'neko' LIMIT 1;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_NEKO_NOT_FOUND: no existe tenant con slug=neko en tabla tenants';
  END IF;

  -- ─── Tax rates ───────────────────────────────────────────────────────────
  INSERT INTO tax_rates (tenant_id, nombre, porcentaje, es_default)
  SELECT v_tenant_id, 'IVA 21%', 21.00, TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM tax_rates
    WHERE tenant_id = v_tenant_id AND nombre = 'IVA 21%' AND deleted_at IS NULL
  );

  INSERT INTO tax_rates (tenant_id, nombre, porcentaje, es_default)
  SELECT v_tenant_id, 'IVA 10.5%', 10.50, FALSE
  WHERE NOT EXISTS (
    SELECT 1 FROM tax_rates
    WHERE tenant_id = v_tenant_id AND nombre = 'IVA 10.5%' AND deleted_at IS NULL
  );

  INSERT INTO tax_rates (tenant_id, nombre, porcentaje, es_default)
  SELECT v_tenant_id, 'Exento', 0.00, FALSE
  WHERE NOT EXISTS (
    SELECT 1 FROM tax_rates
    WHERE tenant_id = v_tenant_id AND nombre = 'Exento' AND deleted_at IS NULL
  );

  -- ─── Canales ─────────────────────────────────────────────────────────────
  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'Salón', 'salon', '🍽️', 'salon', TRUE, 0, 0, 'presencial'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'salon' AND local_id IS NULL AND deleted_at IS NULL
  );

  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'Mostrador', 'mostrador', '☕', 'mostrador', TRUE, -5, 0, 'presencial'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'mostrador' AND local_id IS NULL AND deleted_at IS NULL
  );

  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'Tienda propia', 'tienda-propia', '🏠', 'pedidos', TRUE, 5, 0, 'online-propio'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'tienda-propia' AND local_id IS NULL AND deleted_at IS NULL
  );

  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'Rappi', 'rappi', '🛵', 'pedidos', TRUE, 25, 22, 'third-party'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'rappi' AND local_id IS NULL AND deleted_at IS NULL
  );

  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'PedidosYa', 'pedidos-ya', '🛵', 'pedidos', TRUE, 22, 19, 'third-party'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'pedidos-ya' AND local_id IS NULL AND deleted_at IS NULL
  );

  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'WhatsApp', 'whatsapp', '💬', 'pedidos', TRUE, 0, 0, 'online-propio'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'whatsapp' AND local_id IS NULL AND deleted_at IS NULL
  );

  INSERT INTO canales (tenant_id, nombre, slug, emoji, modo_pos, atado_madre, ajuste_madre_pct, comision_externa_pct, grupo)
  SELECT v_tenant_id, 'Menú QR', 'menu-qr', '📱', 'salon', TRUE, 0, 0, 'presencial'
  WHERE NOT EXISTS (
    SELECT 1 FROM canales WHERE tenant_id = v_tenant_id AND slug = 'menu-qr' AND local_id IS NULL AND deleted_at IS NULL
  );

  RAISE NOTICE 'COMANDA Sprint 1 seeds aplicados sobre tenant_id=%', v_tenant_id;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN COMANDA Sprint 1
-- ═══════════════════════════════════════════════════════════════════════════
