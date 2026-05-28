-- ═══════════════════════════════════════════════════════════════════════════
-- V2 MIGRATION — Spec #1 RRHH rediseño
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration ADITIVA: solo CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN.
-- NO modifica tablas existentes ni borra nada.
-- Sistema actual sigue 100% andando con rrhh_novedades + rrhh_liquidaciones.
-- V2 (pase-pase.vercel.app) usa las tablas nuevas:
--   - rrhh_pay_calendars (frecuencias formalizadas)
--   - rrhh_eventos (eventos discretos con fecha — reemplaza novedades-slot)
--   - rrhh_liquidaciones_v2 (state machine + snapshot empleado)
--
-- Plan completo en docs/superpowers/specs/2026-05-28-rrhh-rediseno-design.md
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. rrhh_pay_calendars ────────────────────────────────────────────────
-- Define las frecuencias de pago disponibles por tenant.
-- Default: cada tenant tiene 3 calendarios estándar (Mensual, Quincenal, Semanal).

CREATE TABLE IF NOT EXISTS rrhh_pay_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre          text NOT NULL,
  frecuencia      text NOT NULL CHECK (frecuencia IN ('DIARIO','SEMANAL','QUINCENAL','MENSUAL')),

  -- Reglas de cutoff y pago (JSON para flexibilidad):
  -- SEMANAL:   { "dia_cierre": 0, "dia_pago": 1 }  (0=domingo, 1=lunes)
  -- QUINCENAL: { "dias_cierre": [15, -1], "dias_pago": [16, 1] }  (-1=último día del mes)
  -- MENSUAL:   { "dia_cierre": -1, "dia_pago_min": 1, "dia_pago_max": 5 }
  reglas          jsonb NOT NULL DEFAULT '{}'::jsonb,

  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, nombre)
);

CREATE INDEX IF NOT EXISTS idx_rrhh_pay_calendars_tenant_activo
  ON rrhh_pay_calendars(tenant_id, activo);

-- RLS
ALTER TABLE rrhh_pay_calendars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON rrhh_pay_calendars;
CREATE POLICY tenant_isolation ON rrhh_pay_calendars
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

COMMENT ON TABLE rrhh_pay_calendars IS
  'V2 RRHH: calendarios de pago por tenant. Cada empleado tendrá FK a uno cuando se complete el rediseño.';

-- ─── 2. rrhh_eventos ──────────────────────────────────────────────────────
-- Reemplaza el modelo "slot mensual por empleado" por eventos discretos con fecha.
-- Patrón Tango/Bejerman/Gusto/R365.

CREATE TABLE IF NOT EXISTS rrhh_eventos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  empleado_id        uuid NOT NULL REFERENCES rrhh_empleados(id) ON DELETE RESTRICT,
  fecha              date NOT NULL,

  -- Tipos de evento (todos los que se pueden cargar manual o automático):
  tipo               text NOT NULL CHECK (tipo IN (
                       'AUSENCIA',
                       'DOBLE',
                       'FERIADO',
                       'HORAS_EXTRA',
                       'VACACION_DIA',
                       'ADELANTO',
                       'OTRO_DESCUENTO',
                       'BONO'
                     )),
  -- Cantidad: días (1.0 para AUSENCIA/DOBLE/FERIADO/VACACION_DIA),
  --           horas (3.5 para HORAS_EXTRA),
  --           pesos ($50000 para ADELANTO/OTRO_DESCUENTO/BONO)
  cantidad           numeric(10,2) NOT NULL,
  comentario         text,

  -- Origen del evento (clave para integración futura con fichero biométrico):
  origen             text NOT NULL DEFAULT 'MANUAL' CHECK (origen IN (
                       'MANUAL',
                       'CALENDARIO',
                       'FICHERO',
                       'SISTEMA'
                     )),

  -- Trazabilidad:
  cargado_por        integer REFERENCES usuarios(id),
  cargado_at         timestamptz NOT NULL DEFAULT now(),

  -- Si vino del fichero, link al punch original (FK se agrega cuando se
  -- implemente rrhh_fichadas_raw en spec futuro):
  fichada_raw_id     uuid,

  -- Si vino del fichero pero fue corregido a mano:
  corregido_por      integer REFERENCES usuarios(id),
  corregido_at       timestamptz,

  -- Para vincular un evento a una liquidación cerrada (snapshot histórico):
  liquidacion_id     uuid
  -- FK se agrega más abajo, después de crear rrhh_liquidaciones_v2
);

CREATE INDEX IF NOT EXISTS idx_rrhh_eventos_emp_fecha
  ON rrhh_eventos(tenant_id, empleado_id, fecha);

CREATE INDEX IF NOT EXISTS idx_rrhh_eventos_tenant_fecha_sin_liq
  ON rrhh_eventos(tenant_id, fecha)
  WHERE liquidacion_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_rrhh_eventos_liquidacion
  ON rrhh_eventos(liquidacion_id)
  WHERE liquidacion_id IS NOT NULL;

-- RLS
ALTER TABLE rrhh_eventos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON rrhh_eventos;
CREATE POLICY tenant_isolation ON rrhh_eventos
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

COMMENT ON TABLE rrhh_eventos IS
  'V2 RRHH: eventos discretos con fecha. Reemplaza rrhh_novedades (que es slot mensual). Coexiste durante transición — v1 sigue usando rrhh_novedades.';

COMMENT ON COLUMN rrhh_eventos.origen IS
  'MANUAL=cargado por Anto/admin. CALENDARIO=encargado lo cargó en vista calendario diaria. FICHERO=reloj biométrico futuro. SISTEMA=trigger automático (ej: migración desde adelantos).';

-- ─── 3. rrhh_liquidaciones_v2 ─────────────────────────────────────────────
-- Nueva tabla con state machine explícito y snapshot del empleado.
-- Coexiste con rrhh_liquidaciones vieja (las pagadas allí quedan congeladas).

CREATE TABLE IF NOT EXISTS rrhh_liquidaciones_v2 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  empleado_id         uuid NOT NULL REFERENCES rrhh_empleados(id),
  pay_calendar_id     uuid REFERENCES rrhh_pay_calendars(id),

  periodo_inicio      date NOT NULL,
  periodo_fin         date NOT NULL,
  fecha_pago_planeada date NOT NULL,

  estado              text NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN (
                        'ABIERTA',
                        'EN_REVISION',
                        'PAGADA',
                        'ANULADA'
                      )),

  -- Snapshot del cálculo:
  sueldo_base                numeric(15,2),
  descuento_ausencias        numeric(15,2) DEFAULT 0,
  plus_dobles                numeric(15,2) DEFAULT 0,
  plus_feriados              numeric(15,2) DEFAULT 0,
  plus_horas_extras          numeric(15,2) DEFAULT 0,
  plus_vacaciones            numeric(15,2) DEFAULT 0,
  presentismo                numeric(15,2) DEFAULT 0,
  bonos                      numeric(15,2) DEFAULT 0,
  subtotal                   numeric(15,2),
  total_bruto                numeric(15,2),
  adelantos_descontados      numeric(15,2) DEFAULT 0,
  otros_descuentos           numeric(15,2) DEFAULT 0,
  total_neto                 numeric(15,2),

  -- Snapshot del empleado al momento del cálculo:
  empleado_snapshot          jsonb,

  -- Pago real:
  pagado_at                  timestamptz,
  pagado_por                 integer REFERENCES usuarios(id),
  movimiento_id              uuid,  -- FK a movimientos cuando exista
  notas                      text,

  -- Auditoría:
  abierta_at                 timestamptz NOT NULL DEFAULT now(),
  abierta_por                integer REFERENCES usuarios(id),
  anulada_at                 timestamptz,
  anulada_por                integer REFERENCES usuarios(id),
  anulada_motivo             text
);

CREATE INDEX IF NOT EXISTS idx_rrhh_liq_v2_pendientes
  ON rrhh_liquidaciones_v2(tenant_id, fecha_pago_planeada)
  WHERE estado IN ('ABIERTA','EN_REVISION');

CREATE INDEX IF NOT EXISTS idx_rrhh_liq_v2_emp_periodo
  ON rrhh_liquidaciones_v2(empleado_id, periodo_inicio);

-- Constraint UNIQUE para evitar liquidaciones duplicadas activas
-- (mismo empleado + mismo período + estado != ANULADA):
CREATE UNIQUE INDEX IF NOT EXISTS uniq_rrhh_liq_v2_emp_periodo_activa
  ON rrhh_liquidaciones_v2(empleado_id, periodo_inicio, periodo_fin)
  WHERE estado != 'ANULADA';

-- RLS
ALTER TABLE rrhh_liquidaciones_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON rrhh_liquidaciones_v2;
CREATE POLICY tenant_isolation ON rrhh_liquidaciones_v2
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

COMMENT ON TABLE rrhh_liquidaciones_v2 IS
  'V2 RRHH: nueva tabla de liquidaciones con state machine. Coexiste con rrhh_liquidaciones vieja durante transición. Las pagadas en v1 quedan congeladas allí; las nuevas usan esta.';

-- Ahora que existe rrhh_liquidaciones_v2, agregar la FK desde rrhh_eventos.liquidacion_id:
ALTER TABLE rrhh_eventos
  DROP CONSTRAINT IF EXISTS fk_rrhh_eventos_liquidacion;

ALTER TABLE rrhh_eventos
  ADD CONSTRAINT fk_rrhh_eventos_liquidacion
  FOREIGN KEY (liquidacion_id)
  REFERENCES rrhh_liquidaciones_v2(id)
  ON DELETE SET NULL;

-- ─── 4. Sembrar calendarios estándar para todos los tenants existentes ────
-- (incluye Lucas Pruebas V2 + Neko prod + cualquier tenant que exista)

INSERT INTO rrhh_pay_calendars (tenant_id, nombre, frecuencia, reglas, activo)
SELECT
  id AS tenant_id,
  'Mensual estándar' AS nombre,
  'MENSUAL' AS frecuencia,
  '{"dia_cierre": -1, "dia_pago_min": 1, "dia_pago_max": 5}'::jsonb AS reglas,
  true AS activo
FROM tenants
ON CONFLICT (tenant_id, nombre) DO NOTHING;

INSERT INTO rrhh_pay_calendars (tenant_id, nombre, frecuencia, reglas, activo)
SELECT
  id AS tenant_id,
  'Quincenal estándar' AS nombre,
  'QUINCENAL' AS frecuencia,
  '{"dias_cierre": [15, -1], "dias_pago": [16, 1]}'::jsonb AS reglas,
  true AS activo
FROM tenants
ON CONFLICT (tenant_id, nombre) DO NOTHING;

INSERT INTO rrhh_pay_calendars (tenant_id, nombre, frecuencia, reglas, activo)
SELECT
  id AS tenant_id,
  'Semanal estándar' AS nombre,
  'SEMANAL' AS frecuencia,
  '{"dia_cierre": 0, "dia_pago": 1}'::jsonb AS reglas,
  true AS activo
FROM tenants
ON CONFLICT (tenant_id, nombre) DO NOTHING;

INSERT INTO rrhh_pay_calendars (tenant_id, nombre, frecuencia, reglas, activo)
SELECT
  id AS tenant_id,
  'Diario estándar' AS nombre,
  'DIARIO' AS frecuencia,
  '{}'::jsonb AS reglas,
  true AS activo
FROM tenants
ON CONFLICT (tenant_id, nombre) DO NOTHING;

-- ─── 5. Verificación ───────────────────────────────────────────────────────
-- Print summary para confirmar que todo se creó OK.

DO $$
DECLARE
  v_calendars int;
  v_eventos_exists boolean;
  v_liq_v2_exists boolean;
BEGIN
  SELECT count(*) INTO v_calendars FROM rrhh_pay_calendars;
  SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='rrhh_eventos') INTO v_eventos_exists;
  SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='rrhh_liquidaciones_v2') INTO v_liq_v2_exists;

  RAISE NOTICE 'V2 RRHH migration aplicada:';
  RAISE NOTICE '  - rrhh_pay_calendars: % filas (% tenants × 4 calendarios)', v_calendars, v_calendars/4;
  RAISE NOTICE '  - rrhh_eventos: %', CASE WHEN v_eventos_exists THEN 'OK' ELSE 'FAIL' END;
  RAISE NOTICE '  - rrhh_liquidaciones_v2: %', CASE WHEN v_liq_v2_exists THEN 'OK' ELSE 'FAIL' END;
END $$;
