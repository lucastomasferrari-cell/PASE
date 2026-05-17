-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 2 competitor F #7 — Manager Logbook (diario del manager)
--
-- Toast/TouchBistro tienen un "shift log" donde el manager anota durante el
-- turno: cliente furioso por demora, faltante de caja $500, cocinero se fue
-- temprano, item agotado, etc. El próximo turno LO LEE primero antes de
-- arrancar — es continuidad operativa.
--
-- Modelo simple:
--   - 1 fila = 1 entrada del logbook.
--   - categoría libre con sugeridos (caja, cocina, cliente, empleado, general).
--   - prioridad (info/atencion/urgente).
--   - pendiente bool → marcable como resuelto por otro manager (cierra loop).
--   - texto libre.
--   - autor + timestamps.
--
-- NO toca dinero, no requiere idempotency, no es C4 — texto puro auditable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS manager_logbook (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id      INTEGER NOT NULL REFERENCES locales(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Autor: empleado POS (rrhh_empleados.id es UUID) — el manager que escribe.
  autor_empleado_id UUID NULL REFERENCES rrhh_empleados(id),
  autor_nombre      TEXT NULL,  -- denormalizado: si el empleado se borra, no perdemos quién escribió

  categoria TEXT NOT NULL DEFAULT 'general' CHECK (
    categoria IN ('caja', 'cocina', 'cliente', 'empleado', 'proveedor', 'general')
  ),
  prioridad TEXT NOT NULL DEFAULT 'info' CHECK (
    prioridad IN ('info', 'atencion', 'urgente')
  ),
  texto     TEXT NOT NULL CHECK (length(trim(texto)) > 0),

  -- Resolución: pendiente=true cuando requiere follow-up. Otro manager lo
  -- marca resuelto al cerrar el loop.
  pendiente BOOLEAN NOT NULL DEFAULT TRUE,
  resuelto_at        TIMESTAMPTZ NULL,
  resuelto_por_id    UUID NULL REFERENCES rrhh_empleados(id),
  resuelto_nombre    TEXT NULL,
  resolucion_nota    TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_logbook_local_pendiente
  ON manager_logbook(local_id, created_at DESC) WHERE pendiente = TRUE;
CREATE INDEX IF NOT EXISTS idx_logbook_local_recientes
  ON manager_logbook(local_id, created_at DESC);

CREATE TRIGGER trg_manager_logbook_set_updated_at BEFORE UPDATE ON manager_logbook
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE manager_logbook ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS logbook_select ON manager_logbook;
CREATE POLICY logbook_select ON manager_logbook FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );

DROP POLICY IF EXISTS logbook_modify ON manager_logbook;
CREATE POLICY logbook_modify ON manager_logbook FOR ALL TO authenticated
  USING (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  )
  WITH CHECK (
    auth_es_superadmin()
    OR (
      tenant_id = auth_tenant_id()
      AND (local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin())
    )
  );

DROP POLICY IF EXISTS logbook_service ON manager_logbook;
CREATE POLICY logbook_service ON manager_logbook FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE manager_logbook IS
  'Diario digital del manager: novedades del turno (caja, cocina, cliente, empleado, proveedor). Pendientes pasan al próximo turno hasta que alguien marque resuelto. Sprint 2 competitor F #7.';

-- ─── RPC: crear entrada ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_logbook_crear(
  p_local_id INTEGER,
  p_empleado_id UUID,
  p_categoria TEXT,
  p_prioridad TEXT,
  p_texto TEXT,
  p_pendiente BOOLEAN DEFAULT TRUE
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
  v_nombre TEXT;
  v_id BIGINT;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;
  IF NOT (p_local_id = ANY(auth_locales_visibles()) OR auth_es_dueno_o_admin() OR auth_es_superadmin()) THEN
    RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
  END IF;

  -- Denormalizar nombre del empleado para auditoría
  SELECT TRIM(COALESCE(apellido,'') || ' ' || COALESCE(nombre,''))
    INTO v_nombre
  FROM rrhh_empleados WHERE id = p_empleado_id;

  INSERT INTO manager_logbook (
    tenant_id, local_id, autor_empleado_id, autor_nombre,
    categoria, prioridad, texto, pendiente
  ) VALUES (
    v_tenant, p_local_id, p_empleado_id, v_nombre,
    p_categoria, p_prioridad, p_texto, p_pendiente
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_logbook_crear(INTEGER, UUID, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_logbook_crear(INTEGER, UUID, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ─── RPC: resolver entrada (cierra pendiente) ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_logbook_resolver(
  p_id BIGINT,
  p_empleado_id UUID,
  p_nota TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
  v_nombre TEXT;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL AND NOT auth_es_superadmin() THEN
    RAISE EXCEPTION 'SIN_TENANT';
  END IF;

  SELECT TRIM(COALESCE(apellido,'') || ' ' || COALESCE(nombre,''))
    INTO v_nombre
  FROM rrhh_empleados WHERE id = p_empleado_id;

  UPDATE manager_logbook SET
    pendiente = FALSE,
    resuelto_at = NOW(),
    resuelto_por_id = p_empleado_id,
    resuelto_nombre = v_nombre,
    resolucion_nota = p_nota
  WHERE id = p_id
    AND pendiente = TRUE
    AND (auth_es_superadmin() OR tenant_id = v_tenant);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOGBOOK_NO_ENCONTRADO_O_YA_RESUELTO';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_logbook_resolver(BIGINT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_logbook_resolver(BIGINT, UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
