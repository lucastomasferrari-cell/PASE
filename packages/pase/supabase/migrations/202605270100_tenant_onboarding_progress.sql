-- ─────────────────────────────────────────────────────────────────────────
-- tenant_onboarding_progress: tracking del wizard de onboarding
-- ─────────────────────────────────────────────────────────────────────────
--
-- Cierra el ticket "Onboarding interactivo" anotado en el análisis
-- estratégico (sesión 25-may): "sin Lucas puede arrancar un local nuevo solo".
--
-- Cuando un nuevo dueño firma un trial, hoy alguien (Lucas o un asistente
-- humano) tiene que ayudarlo manualmente a cargar empleados, insumos, items,
-- categorías de gastos. Eso no escala. Este wizard reemplaza esa fricción.
--
-- 6 pasos del wizard (cada uno con su flag):
--   1. datos_local        — completar dirección, provincia, localidad
--   2. primer_empleado    — crear al menos 1 empleado activo
--   3. primer_insumo      — cargar al menos 1 insumo (vía importador CSV o a mano)
--   4. primer_item        — definir al menos 1 item del menú vendible
--   5. primer_canal       — al menos un canal de venta configurado (salón, etc.)
--   6. completado         — usuario hizo click "Listo, ir al panel"
--
-- Default: tenants viejos (Neko + locales prueba) → todos completados =true
-- vía INSERT en la misma migration. Tenants nuevos arrancan en 0%.
--
-- UI: pantalla `/onboarding` (next sprint) chequea esta tabla. Si algo
-- está incompleto, muestra el step que falta. Si todo está, redirige a
-- /inicio.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_onboarding_progress (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Cada paso tiene su flag + timestamp de cuándo se completó.
  paso_datos_local     BOOLEAN NOT NULL DEFAULT FALSE,
  paso_datos_local_at  TIMESTAMPTZ NULL,
  paso_primer_empleado BOOLEAN NOT NULL DEFAULT FALSE,
  paso_primer_empleado_at TIMESTAMPTZ NULL,
  paso_primer_insumo   BOOLEAN NOT NULL DEFAULT FALSE,
  paso_primer_insumo_at TIMESTAMPTZ NULL,
  paso_primer_item     BOOLEAN NOT NULL DEFAULT FALSE,
  paso_primer_item_at  TIMESTAMPTZ NULL,
  paso_primer_canal    BOOLEAN NOT NULL DEFAULT FALSE,
  paso_primer_canal_at TIMESTAMPTZ NULL,
  completado           BOOLEAN NOT NULL DEFAULT FALSE,
  completado_at        TIMESTAMPTZ NULL,
  -- Track quién acompañó (si fue asistido), para retención
  asistido_por_email   TEXT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_onboarding_progress IS
  'Tracking del wizard de onboarding por tenant. UI /onboarding lee esto '
  'para mostrar el step que falta o redirect a /inicio si está completo.';

-- Trigger touch updated_at
CREATE OR REPLACE FUNCTION fn_tenant_onboarding_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_onboarding_touch ON tenant_onboarding_progress;
CREATE TRIGGER trg_tenant_onboarding_touch
  BEFORE UPDATE ON tenant_onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION fn_tenant_onboarding_touch();

-- RLS dual: lectura/escritura solo del propio tenant. Superadmin bypassa.
ALTER TABLE tenant_onboarding_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_onboarding_select ON tenant_onboarding_progress;
CREATE POLICY tenant_onboarding_select ON tenant_onboarding_progress
  FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id() OR auth_es_superadmin());

DROP POLICY IF EXISTS tenant_onboarding_insert ON tenant_onboarding_progress;
CREATE POLICY tenant_onboarding_insert ON tenant_onboarding_progress
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth_tenant_id() OR auth_es_superadmin());

DROP POLICY IF EXISTS tenant_onboarding_update ON tenant_onboarding_progress;
CREATE POLICY tenant_onboarding_update ON tenant_onboarding_progress
  FOR UPDATE TO authenticated
  USING (tenant_id = auth_tenant_id() OR auth_es_superadmin())
  WITH CHECK (tenant_id = auth_tenant_id() OR auth_es_superadmin());

-- ─── Backfill: tenants existentes arrancan con onboarding completado ────
-- Neko + locales prueba + cualquier tenant existente. Si pasamos algo a
-- producción con onboarding incompleto, no rompe ningún flow viejo.
INSERT INTO tenant_onboarding_progress (
  tenant_id, paso_datos_local, paso_datos_local_at,
  paso_primer_empleado, paso_primer_empleado_at,
  paso_primer_insumo, paso_primer_insumo_at,
  paso_primer_item, paso_primer_item_at,
  paso_primer_canal, paso_primer_canal_at,
  completado, completado_at
)
SELECT
  id, TRUE, now(), TRUE, now(), TRUE, now(),
  TRUE, now(), TRUE, now(), TRUE, now()
FROM tenants
WHERE id NOT IN (SELECT tenant_id FROM tenant_onboarding_progress)
ON CONFLICT (tenant_id) DO NOTHING;

-- ─── RPC helper: completar paso (idempotente) ──────────────────────────
-- Llamada desde el frontend después de cada paso del wizard.
CREATE OR REPLACE FUNCTION fn_onboarding_completar_paso(p_paso TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := auth_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- Asegurar que existe la fila (en caso edge de tenant creado sin row).
  INSERT INTO tenant_onboarding_progress (tenant_id)
  VALUES (v_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  -- Marcar el paso. Usamos CASE en lugar de dynamic SQL para evitar
  -- inyección. Lista cerrada de pasos válidos.
  CASE p_paso
    WHEN 'datos_local' THEN
      UPDATE tenant_onboarding_progress
        SET paso_datos_local = TRUE, paso_datos_local_at = COALESCE(paso_datos_local_at, now())
        WHERE tenant_id = v_tenant_id;
    WHEN 'primer_empleado' THEN
      UPDATE tenant_onboarding_progress
        SET paso_primer_empleado = TRUE, paso_primer_empleado_at = COALESCE(paso_primer_empleado_at, now())
        WHERE tenant_id = v_tenant_id;
    WHEN 'primer_insumo' THEN
      UPDATE tenant_onboarding_progress
        SET paso_primer_insumo = TRUE, paso_primer_insumo_at = COALESCE(paso_primer_insumo_at, now())
        WHERE tenant_id = v_tenant_id;
    WHEN 'primer_item' THEN
      UPDATE tenant_onboarding_progress
        SET paso_primer_item = TRUE, paso_primer_item_at = COALESCE(paso_primer_item_at, now())
        WHERE tenant_id = v_tenant_id;
    WHEN 'primer_canal' THEN
      UPDATE tenant_onboarding_progress
        SET paso_primer_canal = TRUE, paso_primer_canal_at = COALESCE(paso_primer_canal_at, now())
        WHERE tenant_id = v_tenant_id;
    WHEN 'completado' THEN
      UPDATE tenant_onboarding_progress
        SET completado = TRUE, completado_at = COALESCE(completado_at, now())
        WHERE tenant_id = v_tenant_id;
    ELSE
      RAISE EXCEPTION 'PASO_INVALIDO: %', p_paso;
  END CASE;
END;
$$;

COMMENT ON FUNCTION fn_onboarding_completar_paso IS
  'Marca un paso del wizard como completado (idempotente). Lista cerrada '
  'de pasos válidos para evitar inyección.';
