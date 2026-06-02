-- 202606021700_audit_tenants_huerfanos.sql
-- Audit-only: cuenta filas con tenant_id huérfano en tablas críticas.
--
-- Bug histórico (2026-06-02 mañana): el backfill de timestamps en
-- ventas_pos falló porque hay rows con tenant_id de tenants eliminados.
-- Postgres revalida FK en UPDATE si el row no existe en la tabla padre
-- → constraint violation → migration rota.
--
-- Esta migration NO BORRA NADA. Solo:
--   1. Crea vista materializada-like (TEMP) con counts por tabla.
--   2. RAISE NOTICE con el reporte en formato legible.
--   3. Si total > 0, INSERTa a `tenants_huerfanos_audit` (tabla nueva)
--      para histórico — Lucas puede consultar después con SELECT.
--
-- Para BORRAR después de revisar (NO ejecutar acá, hacer migration aparte):
--   UPDATE ventas_pos SET deleted_at = NOW() WHERE tenant_id NOT IN (SELECT id FROM tenants);
--   (idem para cada tabla con huérfanos)

-- ─── 1. Tabla audit log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants_huerfanos_audit (
  id              BIGSERIAL PRIMARY KEY,
  audit_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tabla           TEXT NOT NULL,
  filas_huerfanas BIGINT NOT NULL,
  tenant_ids_huerfanos UUID[] NULL,
  notas           TEXT NULL
);

COMMENT ON TABLE tenants_huerfanos_audit IS
  'Histórico de auditorías de huérfanos. Cada corrida del cron / migration ' ||
  'agrega una fila por tabla con count > 0. Audit-only — no afecta nada.';

-- ─── 2. Función de audit (callable por humano cuando quiera) ────────────────
CREATE OR REPLACE FUNCTION fn_audit_tenants_huerfanos()
RETURNS TABLE (
  tabla TEXT,
  filas_huerfanas BIGINT,
  tenant_ids_huerfanos UUID[]
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_audit_at TIMESTAMPTZ := NOW();
  v_count BIGINT;
  v_uuids UUID[];
BEGIN
  -- Listado de tablas a auditar (las críticas + las más grandes).
  -- Si aparece una nueva en el futuro, agregarla acá.
  -- Cada bloque hace: SELECT count + array_agg distinct tenant_ids → loguea.

  -- ventas_pos
  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM ventas_pos WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'ventas_pos', v_count, v_uuids);
    tabla := 'ventas_pos'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM ventas_pos_items WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'ventas_pos_items', v_count, v_uuids);
    tabla := 'ventas_pos_items'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM ventas_pos_pagos WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'ventas_pos_pagos', v_count, v_uuids);
    tabla := 'ventas_pos_pagos'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM movimientos WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'movimientos', v_count, v_uuids);
    tabla := 'movimientos'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM saldos_caja WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'saldos_caja', v_count, v_uuids);
    tabla := 'saldos_caja'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM gastos WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'gastos', v_count, v_uuids);
    tabla := 'gastos'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM facturas WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'facturas', v_count, v_uuids);
    tabla := 'facturas'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM rrhh_empleados WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'rrhh_empleados', v_count, v_uuids);
    tabla := 'rrhh_empleados'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM rrhh_liquidaciones WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'rrhh_liquidaciones', v_count, v_uuids);
    tabla := 'rrhh_liquidaciones'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM clientes WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'clientes', v_count, v_uuids);
    tabla := 'clientes'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;

  SELECT COUNT(*), ARRAY_AGG(DISTINCT tenant_id) INTO v_count, v_uuids
    FROM mesas WHERE tenant_id NOT IN (SELECT id FROM tenants);
  IF v_count > 0 THEN
    INSERT INTO tenants_huerfanos_audit (audit_at, tabla, filas_huerfanas, tenant_ids_huerfanos)
    VALUES (v_audit_at, 'mesas', v_count, v_uuids);
    tabla := 'mesas'; filas_huerfanas := v_count; tenant_ids_huerfanos := v_uuids; RETURN NEXT;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_audit_tenants_huerfanos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_audit_tenants_huerfanos() TO authenticated, service_role;

-- ─── 3. Correr el audit ahora mismo (al pegar este SQL) ─────────────────────
DO $$
DECLARE
  v_total BIGINT := 0;
  v_row RECORD;
BEGIN
  FOR v_row IN SELECT * FROM fn_audit_tenants_huerfanos() LOOP
    v_total := v_total + v_row.filas_huerfanas;
    RAISE NOTICE 'AUDIT HUÉRFANOS: tabla=% filas=% tenant_ids=%',
      v_row.tabla, v_row.filas_huerfanas, v_row.tenant_ids_huerfanos;
  END LOOP;
  IF v_total = 0 THEN
    RAISE NOTICE 'AUDIT HUÉRFANOS: ✓ ninguna tabla tiene tenant_id huérfano.';
  ELSE
    RAISE NOTICE 'AUDIT HUÉRFANOS: ⚠️  TOTAL=% filas distribuidas en N tablas. Revisar SELECT * FROM tenants_huerfanos_audit ORDER BY id DESC.', v_total;
  END IF;
END $$;

-- ─── 4. Cómo BORRAR (NO ejecutar acá, hacer migration aparte) ──────────────
-- Si querés borrar las huérfanas:
--   SELECT * FROM tenants_huerfanos_audit ORDER BY id DESC LIMIT 20;
-- Para revisar cuáles tenant_ids son.
-- Después por cada tabla con count > 0:
--   UPDATE ventas_pos SET deleted_at = NOW()
--    WHERE tenant_id NOT IN (SELECT id FROM tenants) AND deleted_at IS NULL;
-- Soft-delete preferido (deja la fila para auditoría). Hard-delete:
--   DELETE FROM ventas_pos WHERE tenant_id NOT IN (SELECT id FROM tenants);
-- ⚠️ DELETE puede fallar por FKs en cascada — preferir UPDATE SET deleted_at.

NOTIFY pgrst, 'reload schema';
