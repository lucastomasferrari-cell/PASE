-- ═══════════════════════════════════════════════════════════════════════════
-- Feature 2: Empleados que trabajan en múltiples locales
--
-- Caso de uso (Lucas): el equipo administrativo está dado de alta en
-- Villa Crespo, pero trabaja para Belgrano y Devoto también. Hoy
-- rrhh_empleados.local_id es FK 1:1, así que un encargado de Belgrano
-- no ve a esa persona en su lista de empleados.
--
-- Modelo: nueva tabla rrhh_empleado_locales (m:n).
--   - Cada empleado tiene >= 1 fila acá.
--   - es_principal=TRUE marca el "local de origen" (mismo que
--     rrhh_empleados.local_id, mantenido por back-compat).
--   - Los demás locales son "cesiones" — el empleado trabaja para ellos.
--   - Permisos: usuario ve un empleado si tiene visibilidad sobre AL MENOS
--     UNO de sus locales asignados.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rrhh_empleado_locales (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  empleado_id     UUID NOT NULL REFERENCES rrhh_empleados(id) ON DELETE CASCADE,
  local_id        INTEGER NOT NULL REFERENCES locales(id),
  -- es_principal: el "local de origen" del empleado. Debe haber exactamente
  -- 1 por empleado (constraint via index único parcial).
  es_principal    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Tipo de relación
  tipo            TEXT NOT NULL DEFAULT 'asignado'
                  CHECK (tipo IN ('asignado', 'cesion_temporal', 'cesion_permanente')),
  fecha_desde     DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_hasta     DATE,    -- NULL = sin fecha de fin
  notas           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  UNIQUE (empleado_id, local_id)
);

-- Solo 1 local principal por empleado (cuando no está borrado)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_empleado_local_principal
  ON rrhh_empleado_locales(empleado_id)
  WHERE es_principal = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_empleado_locales_local
  ON rrhh_empleado_locales(local_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_empleado_locales_emp
  ON rrhh_empleado_locales(empleado_id, deleted_at);

COMMENT ON TABLE rrhh_empleado_locales IS
  'M:N entre empleados y locales. Cada empleado tiene 1 principal + N cesiones. Permite que admin de Villa Crespo trabaje para Belgrano y Devoto.';

-- ─── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE rrhh_empleado_locales ENABLE ROW LEVEL SECURITY;

CREATE POLICY empleado_locales_all ON rrhh_empleado_locales
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- Updated_at
CREATE OR REPLACE FUNCTION trg_empleado_locales_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS empleado_locales_updated_at ON rrhh_empleado_locales;
CREATE TRIGGER empleado_locales_updated_at
  BEFORE UPDATE ON rrhh_empleado_locales
  FOR EACH ROW EXECUTE FUNCTION trg_empleado_locales_updated_at();

-- ─── BACKFILL ─────────────────────────────────────────────────────────────
-- Para cada empleado existente, crear fila principal con su local_id actual.
INSERT INTO rrhh_empleado_locales (tenant_id, empleado_id, local_id, es_principal, tipo, fecha_desde)
SELECT
  e.tenant_id, e.id, e.local_id, TRUE, 'asignado', COALESCE(e.fecha_inicio, CURRENT_DATE - INTERVAL '1 year')::DATE
FROM rrhh_empleados e
WHERE NOT EXISTS (
  SELECT 1 FROM rrhh_empleado_locales rel
  WHERE rel.empleado_id = e.id AND rel.es_principal = TRUE
)
ON CONFLICT (empleado_id, local_id) DO NOTHING;

-- ─── Vista helper: empleados visibles para el usuario actual ──────────────
-- Devuelve cada empleado con sus locales (array) + el principal.
-- La pantalla RRHH puede usar esto para mostrar empleados de otros locales
-- que el usuario puede gestionar via cesión.
CREATE OR REPLACE VIEW v_rrhh_empleados_visible AS
SELECT
  e.id,
  e.tenant_id,
  e.local_id AS local_principal_id,
  e.nombre,
  e.activo,
  -- agregamos un array con TODOS los locales donde trabaja
  ARRAY(
    SELECT rel.local_id FROM rrhh_empleado_locales rel
     WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL
     ORDER BY rel.es_principal DESC, rel.local_id
  ) AS locales_ids,
  -- cantidad de cesiones (excluye principal)
  (SELECT COUNT(*) FROM rrhh_empleado_locales rel
    WHERE rel.empleado_id = e.id AND rel.deleted_at IS NULL
      AND rel.es_principal = FALSE) AS cantidad_cesiones,
  e.creado_at AS created_at,
  e.fecha_inicio
FROM rrhh_empleados e
WHERE e.fecha_egreso IS NULL OR e.fecha_egreso >= CURRENT_DATE - INTERVAL '90 days';
-- (Vemos activos + recientemente egresados, para que el frontend muestre los
--  últimos liquidados aunque ya no estén activos.)

GRANT SELECT ON v_rrhh_empleados_visible TO authenticated;

-- ─── RPC: ceder empleado a otro local ─────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_ceder_empleado_a_local(
  p_empleado_id UUID,
  p_local_destino_id INTEGER,
  p_tipo TEXT DEFAULT 'cesion_permanente',
  p_fecha_desde DATE DEFAULT NULL,
  p_fecha_hasta DATE DEFAULT NULL,
  p_notas TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_emp_local_origen INTEGER;
  v_id BIGINT;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_tipo NOT IN ('asignado','cesion_temporal','cesion_permanente') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;

  -- Validar empleado
  SELECT local_id INTO v_emp_local_origen FROM rrhh_empleados
   WHERE id = p_empleado_id AND tenant_id = v_tenant_id;
  IF v_emp_local_origen IS NULL THEN RAISE EXCEPTION 'EMPLEADO_NO_ENCONTRADO'; END IF;

  -- Validar local destino existe + permisos
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_destino_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO';
  END IF;
  -- El operador debe tener acceso AL local origen del empleado (para ceder).
  IF NOT (auth_es_dueno_o_admin() OR v_emp_local_origen = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  IF p_local_destino_id = v_emp_local_origen THEN
    RAISE EXCEPTION 'YA_ES_LOCAL_PRINCIPAL';
  END IF;

  -- INSERT o UPDATE si ya existe la combinación
  INSERT INTO rrhh_empleado_locales (
    tenant_id, empleado_id, local_id, es_principal, tipo,
    fecha_desde, fecha_hasta, notas
  ) VALUES (
    v_tenant_id, p_empleado_id, p_local_destino_id, FALSE, p_tipo,
    COALESCE(p_fecha_desde, CURRENT_DATE), p_fecha_hasta, p_notas
  )
  ON CONFLICT (empleado_id, local_id) DO UPDATE SET
    tipo = EXCLUDED.tipo,
    fecha_hasta = EXCLUDED.fecha_hasta,
    notas = EXCLUDED.notas,
    deleted_at = NULL,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_ceder_empleado_a_local(UUID, INTEGER, TEXT, DATE, DATE, TEXT) TO authenticated;

-- ─── RPC: revocar cesión ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_revocar_cesion_empleado(
  p_empleado_id UUID,
  p_local_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_es_principal BOOLEAN;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  SELECT es_principal INTO v_es_principal FROM rrhh_empleado_locales
   WHERE empleado_id = p_empleado_id AND local_id = p_local_id
     AND tenant_id = v_tenant_id AND deleted_at IS NULL;
  IF v_es_principal IS NULL THEN RAISE EXCEPTION 'CESION_NO_ENCONTRADA'; END IF;
  IF v_es_principal THEN RAISE EXCEPTION 'NO_REVOCAR_PRINCIPAL'; END IF;

  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  UPDATE rrhh_empleado_locales SET
    deleted_at = NOW(),
    updated_at = NOW()
  WHERE empleado_id = p_empleado_id AND local_id = p_local_id;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_revocar_cesion_empleado(UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
