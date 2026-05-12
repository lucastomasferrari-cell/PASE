-- ═══════════════════════════════════════════════════════════════════════════
-- rrhh_puestos: catálogo de puestos disponibles, gestionable desde Configuración.
--
-- Antes: rrhh_empleados.puesto era TEXT libre. Resultado reportado por Lucas
-- 2026-05-12: "en un local Camilo ve los puestos pero en otro no" — porque
-- el dropdown se construía de los valores tipeados, distintos por local.
--
-- Fix: catálogo persistente con (id, nombre, activo, orden, tenant_id).
-- Patrón idéntico a config_categorias / medios_cobro post-fix de hoy:
--   - SELECT abierto a todo authenticated del tenant (todos ven la misma
--     lista, sin depender del permiso configuracion).
--   - Escritura con auth_tiene_permiso('configuracion').
-- Conserva la columna rrhh_empleados.puesto como TEXT (sin FK) para
-- retro-compat: empleados existentes con puestos "viejos" siguen mostrando
-- su valor aunque ya no esté activo en el catálogo. El dropdown del form
-- inserta nuevos puestos solo del catálogo activo.
--
-- Backfill: insertamos los valores únicos de rrhh_empleados.puesto que ya
-- estaban cargados, así Lucas no arranca con catálogo vacío.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rrhh_puestos (
  id          BIGSERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  activo      BOOLEAN NOT NULL DEFAULT true,
  orden       INTEGER NOT NULL DEFAULT 0,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
              DEFAULT auth_tenant_id(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nombre)
);

CREATE INDEX IF NOT EXISTS idx_rrhh_puestos_tenant
  ON rrhh_puestos(tenant_id) WHERE activo = true;

ALTER TABLE rrhh_puestos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rrhh_puestos_select ON rrhh_puestos;
DROP POLICY IF EXISTS rrhh_puestos_write ON rrhh_puestos;

-- SELECT abierto: todos los users del tenant ven la misma lista.
CREATE POLICY rrhh_puestos_select ON rrhh_puestos
  FOR SELECT TO authenticated
  USING (auth_es_superadmin() OR tenant_id = auth_tenant_id());

-- Escritura: requiere permiso 'configuracion' (mismo gate que el resto del módulo).
CREATE POLICY rrhh_puestos_write ON rrhh_puestos
  FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_tiene_permiso('configuracion')));

-- Backfill: cargar el catálogo con los puestos únicos que ya están en uso.
-- Asignamos orden = 10, 20, 30... por inserción. ON CONFLICT DO NOTHING para
-- idempotencia (la migration es seguro re-correrla).
INSERT INTO rrhh_puestos (nombre, tenant_id, orden)
SELECT DISTINCT trim(e.puesto), e.tenant_id, 10
  FROM rrhh_empleados e
 WHERE e.puesto IS NOT NULL
   AND trim(e.puesto) <> ''
   AND e.tenant_id IS NOT NULL
ON CONFLICT (tenant_id, nombre) DO NOTHING;

COMMENT ON TABLE rrhh_puestos IS
  'Catálogo de puestos disponibles para empleados RRHH. SELECT abierto a '
  'todo el tenant (todos ven misma lista); escritura solo con permiso '
  'configuracion. rrhh_empleados.puesto sigue siendo TEXT libre por '
  'retro-compat (empleados con puestos legacy no se rompen).';
