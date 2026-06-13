-- ─────────────────────────────────────────────────────────────────────────
-- fn_onboarding_autodetectar: marca los pasos del onboarding por DATO REAL
-- ─────────────────────────────────────────────────────────────────────────
--
-- Tier 3 (informe 14-ux-settings-onboarding): el checklist de bienvenida en
-- el Home debe AUTO-completarse cuando el dueño hace la acción real, no a mano.
--
-- Esta RPC mira los datos reales del tenant y marca TRUE (con timestamp) cada
-- paso que esté FALSE pero cuyo dato ya exista. Es idempotente: solo hace
-- FALSE → TRUE, nunca desmarca. NO marca `completado` (eso es decisión
-- explícita del dueño vía botón "Listo, no mostrar más").
--
-- Detección por paso (columnas verificadas recon 13-jun):
--   datos_local     → locales del tenant con provincia O localidad NOT NULL.
--   primer_empleado → rrhh_empleados activo=TRUE del tenant (no tiene deleted_at).
--   primer_insumo   → insumos del tenant, deleted_at IS NULL.
--   primer_item     → items del tenant, deleted_at IS NULL.
--   primer_canal    → canales del tenant, deleted_at IS NULL.
--
-- Reusa el patrón INSERT-if-missing de fn_onboarding_completar_paso
-- (migration 202605270100). Devuelve la fila completa como jsonb para que el
-- widget la use sin un segundo round-trip.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION fn_onboarding_autodetectar()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := auth_tenant_id();
  v_row       tenant_onboarding_progress%ROWTYPE;
BEGIN
  -- Sin tenant en el JWT no hacemos nada (no auth → no-op).
  IF v_tenant_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Asegurar que la fila existe (tenant nuevo puede no tenerla todavía).
  INSERT INTO tenant_onboarding_progress (tenant_id)
  VALUES (v_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  -- Marcar cada paso FALSE cuyo dato real exista. Idempotente: el guard
  -- `<flag> = FALSE` evita reescribir timestamps de pasos ya marcados.
  UPDATE tenant_onboarding_progress
     SET paso_datos_local = TRUE,
         paso_datos_local_at = COALESCE(paso_datos_local_at, now())
   WHERE tenant_id = v_tenant_id
     AND paso_datos_local = FALSE
     AND EXISTS (
       SELECT 1 FROM locales l
        WHERE l.tenant_id = v_tenant_id
          AND (l.provincia IS NOT NULL OR l.localidad IS NOT NULL)
     );

  UPDATE tenant_onboarding_progress
     SET paso_primer_empleado = TRUE,
         paso_primer_empleado_at = COALESCE(paso_primer_empleado_at, now())
   WHERE tenant_id = v_tenant_id
     AND paso_primer_empleado = FALSE
     AND EXISTS (
       SELECT 1 FROM rrhh_empleados e
        WHERE e.tenant_id = v_tenant_id
          AND e.activo = TRUE
     );

  UPDATE tenant_onboarding_progress
     SET paso_primer_insumo = TRUE,
         paso_primer_insumo_at = COALESCE(paso_primer_insumo_at, now())
   WHERE tenant_id = v_tenant_id
     AND paso_primer_insumo = FALSE
     AND EXISTS (
       SELECT 1 FROM insumos i
        WHERE i.tenant_id = v_tenant_id
          AND i.deleted_at IS NULL
     );

  UPDATE tenant_onboarding_progress
     SET paso_primer_item = TRUE,
         paso_primer_item_at = COALESCE(paso_primer_item_at, now())
   WHERE tenant_id = v_tenant_id
     AND paso_primer_item = FALSE
     AND EXISTS (
       SELECT 1 FROM items it
        WHERE it.tenant_id = v_tenant_id
          AND it.deleted_at IS NULL
     );

  UPDATE tenant_onboarding_progress
     SET paso_primer_canal = TRUE,
         paso_primer_canal_at = COALESCE(paso_primer_canal_at, now())
   WHERE tenant_id = v_tenant_id
     AND paso_primer_canal = FALSE
     AND EXISTS (
       SELECT 1 FROM canales c
        WHERE c.tenant_id = v_tenant_id
          AND c.deleted_at IS NULL
     );

  -- Devolver la fila ya actualizada (mismo shape que getOnboardingProgress).
  SELECT * INTO v_row
    FROM tenant_onboarding_progress
   WHERE tenant_id = v_tenant_id;

  RETURN to_jsonb(v_row);
END;
$$;

COMMENT ON FUNCTION fn_onboarding_autodetectar IS
  'Marca los pasos del onboarding por dato real del tenant (idempotente, solo '
  'FALSE→TRUE; NO marca completado). Devuelve la fila como jsonb. Tier 3.';

-- C7 / regla 11-jun: PUBLIC solo no alcanza — revocar explícito de PUBLIC y anon.
REVOKE ALL ON FUNCTION fn_onboarding_autodetectar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_onboarding_autodetectar() TO authenticated;

COMMIT;
