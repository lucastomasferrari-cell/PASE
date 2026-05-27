-- =============================================================================
-- HOTFIX 2026-05-27 — ON CONFLICT (rpc_name, key) → (rpc_name, key, tenant_id)
-- =============================================================================
-- Bug reportado por Lucas: cargar factura con Lector IA o NC manual fallaba
-- con "there is no unique or exclusion constraint matching the on conflict
-- specification".
--
-- Causa raíz: la migration F2 (202605270800_audit_f2_criticos.sql) cambió la
-- PK de idempotency_keys a (rpc_name, key, tenant_id) — el PK viejo de 2
-- columnas dejó de existir. Las RPCs que F1 tocó (pagar_sueldo, pagar_factura,
-- aplicar_nc_a_factura, crear_gasto_empleado) fueron actualizadas en F2 al
-- nuevo PK. Pero NO se actualizaron las OTRAS 9 RPCs del codebase que también
-- insertan en idempotency_keys con `ON CONFLICT (rpc_name, key)`.
--
-- Lista de las 9 RPCs:
--   - crear_cierre_ventas
--   - fn_conciliar_mp_con_facturas
--   - crear_factura_completa            ← raíz del bug del Lector IA + NC
--   - cambiar_sueldo_empleado
--   - editar_gasto
--   - editar_movimiento_caja
--   - fn_crear_pedido_publico_comanda
--   - vincular_remito_factura
--   - fn_importar_recetas_bulk
--
-- Solución aplicada: el script `_fix_conflict.cjs` leyó la definición live de
-- cada una vía pg_get_functiondef, hizo replace del string viejo por el nuevo
-- y CREATE OR REPLACE FUNCTION. Verificado que cada INSERT INTO
-- idempotency_keys YA incluía tenant_id en las columnas insertadas (porque
-- el cambio del PK lo requería para el INSERT también).
--
-- Esta migration es declarativa: declara el cambio aplicado. La forma real
-- del fix fue programática (cada función es grande). El script de aplicación
-- corrió en transacción + COMMIT exitoso a las 2026-05-27.
--
-- Smoke check: las 9 RPCs ahora deben tener ON CONFLICT con 3 columnas.
-- =============================================================================

BEGIN;

DO $smoke$
DECLARE
  v_n integer;
  v_remaining text[];
BEGIN
  SELECT array_agg(p.proname), COUNT(*)
    INTO v_remaining, v_n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND pg_get_functiondef(p.oid) ILIKE '%ON CONFLICT (rpc_name, key)%'
    AND pg_get_functiondef(p.oid) NOT ILIKE '%ON CONFLICT (rpc_name, key, tenant_id)%';

  IF v_n > 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL hotfix: % RPCs todavía con ON CONFLICT viejo: %', v_n, v_remaining;
  END IF;
  RAISE NOTICE 'SMOKE OK hotfix: cero RPCs con ON CONFLICT (rpc_name, key) viejo';
END $smoke$;

COMMIT;
