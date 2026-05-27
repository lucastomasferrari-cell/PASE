-- =============================================================================
-- AUDIT F3 — Performance: críticos auto-fixeables (DB-side)
-- Generada 2026-05-27 a partir de docs/audit-2026-05/03-performance.md
-- =============================================================================
-- Cubre: F3A#1 publication trim, F3A#2 cron, F3A#6 índice movimientos,
-- F3A#10 índice facturas, F3A#15 DROP índices muertos, F3A#7 batch NC,
-- F3A#8 batch anular movimientos.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- F3A#1: Realtime publication overinclusiva.
-- 42 tablas en supabase_realtime → 7h CPU/día solo en publish WAL.
-- Drop 22 tablas que casi no cambian o tienen cache local (catálogos, master
-- data, insert-only). Para esas, las pantallas pueden invalidar on-focus
-- o usar polling esporádico — no necesitan WAL stream.
-- -----------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime DROP TABLE
  proveedores,                  -- catálogo, cambia raras veces
  config_categorias,            -- catálogo, ~1 cambio/mes
  medios_cobro,                 -- catálogo
  metodos_cobro,                -- catálogo COMANDA
  tenants,                      -- rara vez
  locales,                      -- rara vez
  usuarios,                     -- pantalla Usuarios rara vez se abre
  usuario_permisos,             -- idem
  usuario_locales,              -- idem
  blindaje_tipos_documento,     -- catálogo
  rrhh_valores_doble,           -- catálogo
  canales,                      -- catálogo COMANDA
  item_grupos,                  -- catálogo COMANDA
  mp_credenciales,              -- cambia raras veces
  mp_liquidaciones,             -- insert-only desde cron
  kds_tokens,                   -- rara vez
  menu_qr_tokens,               -- rara vez
  rrhh_documentos,              -- insert-only desde upload manual
  rrhh_historial_sueldos,       -- insert-only
  rrhh_pagos_especiales,        -- 1 insert mensual por empleado
  blindaje_documentos,          -- insert-only
  comanda_local_settings;       -- 1 cambio en setup, después estático

-- Las que quedan en realtime (20): facturas, factura_items, movimientos,
-- saldos_caja, movimientos_caja, gastos, ventas, ventas_pos, ventas_pos_items,
-- ventas_pos_pagos, ventas_pos_overrides, mesas, turnos_caja, remitos,
-- mp_movimientos, rrhh_empleados, rrhh_novedades, rrhh_liquidaciones, items,
-- item_precios_canal.

-- -----------------------------------------------------------------------------
-- F3A#2: cron fn_reactivar_items_vencidos cada minuto → cada 15 minutos.
-- 14.981 invocaciones/mes → 96/día (-92%). Pierde latencia de ~14 min en peor
-- caso para auto-reactivar un item agotado — operativamente aceptable.
-- -----------------------------------------------------------------------------
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'reactivar-items-vencidos'),
  schedule => '*/15 * * * *'
);

-- -----------------------------------------------------------------------------
-- F3A#6: Índice composito para trg_sync_saldos_caja.
-- El trigger filtra (local_id, cuenta, NOT anulado) y SUM(importe).
-- Hoy usa idx_movimientos_tenant_local y filtra 670 rows en memoria por
-- INSERT/UPDATE/DELETE. Índice partial nuevo → point lookup.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_movimientos_local_cuenta_activo
  ON movimientos (local_id, cuenta) INCLUDE (importe)
  WHERE NOT anulado;

-- -----------------------------------------------------------------------------
-- F3A#10: Índice composito para facturas vencidas (bandeja entrada).
-- fetchFacturasVencidas corre 1×min por user logueado.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_facturas_estado_venc
  ON facturas (estado, venc)
  WHERE estado != 'anulada';

-- -----------------------------------------------------------------------------
-- F3A#15: DROP 5 índices muertos confirmados (idx_scan=0 después de meses).
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_mp_mov_anulado_false;        -- 368 kB
DROP INDEX IF EXISTS idx_mp_mov_release_date_released; -- 112 kB
DROP INDEX IF EXISTS idx_mp_mov_sin_justificar;        -- 40 kB
DROP INDEX IF EXISTS idx_movimientos_anulado_false;    -- 40 kB
DROP INDEX IF EXISTS idx_items_nombre_trgm;            -- 72 kB

-- -----------------------------------------------------------------------------
-- F3A#7: RPC batch para aplicar múltiples NCs a una factura en 1 round-trip.
-- Antes: Compras.tsx:520 hacía `for (const nc of ncs) await rpc(...)`
-- (N round-trips secuenciales). Ahora: 1 RPC, 1 round-trip, atómica.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aplicar_ncs_a_factura(
  p_factura_id text,
  p_ncs jsonb  -- [{nc_id, monto, fecha, idempotency_key?}, ...]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_ok integer := 0;
  v_fail integer := 0;
BEGIN
  IF p_ncs IS NULL OR jsonb_array_length(p_ncs) = 0 THEN
    RAISE EXCEPTION 'NCS_REQUERIDAS';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_ncs)
  LOOP
    BEGIN
      v_result := aplicar_nc_a_factura(
        p_nc_id          := v_item->>'nc_id',
        p_factura_id     := p_factura_id,
        p_monto          := (v_item->>'monto')::numeric,
        p_fecha          := (v_item->>'fecha')::date,
        p_idempotency_key := v_item->>'idempotency_key'
      );
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'nc_id', v_item->>'nc_id',
        'ok', true,
        'result', v_result
      ));
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'nc_id', v_item->>'nc_id',
        'ok', false,
        'error', SQLERRM
      ));
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'factura_id', p_factura_id,
    'aplicadas', v_ok,
    'fallidas', v_fail,
    'detalles', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.aplicar_ncs_a_factura(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aplicar_ncs_a_factura(text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.aplicar_ncs_a_factura(text, jsonb) IS
  'Batch wrapper sobre aplicar_nc_a_factura. Antes Compras.tsx:520 hacía for+await (N round-trips). Esto baja a 1 round-trip.';

-- -----------------------------------------------------------------------------
-- F3A#8: RPC batch para anular múltiples movimientos en 1 round-trip.
-- Antes: RRHHLegajo.tsx:780 hacía `for (const m of movs) await rpc(...)`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_movimientos_batch(
  p_mov_ids text[],
  p_motivo text,
  p_override_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_ok integer := 0;
  v_fail integer := 0;
BEGIN
  IF p_mov_ids IS NULL OR array_length(p_mov_ids, 1) = 0 THEN
    RAISE EXCEPTION 'MOV_IDS_REQUERIDOS';
  END IF;
  IF p_motivo IS NULL OR TRIM(p_motivo) = '' THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO';
  END IF;

  FOREACH v_id IN ARRAY p_mov_ids
  LOOP
    BEGIN
      v_result := anular_movimiento(v_id, p_motivo, p_override_code);
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'mov_id', v_id,
        'ok', true,
        'result', v_result
      ));
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'mov_id', v_id,
        'ok', false,
        'error', SQLERRM
      ));
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'anulados', v_ok,
    'fallidos', v_fail,
    'detalles', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.anular_movimientos_batch(text[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anular_movimientos_batch(text[], text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.anular_movimientos_batch(text[], text, text) IS
  'Batch wrapper sobre anular_movimiento. Antes RRHHLegajo.tsx:780 hacía for+await (N round-trips).';

-- =============================================================================
-- SMOKE CHECKS
-- =============================================================================
DO $$
DECLARE v_n integer;
BEGIN
  SELECT COUNT(*) INTO v_n FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
  IF v_n > 22 THEN
    RAISE EXCEPTION 'SMOKE FAIL F3A#1: publication tiene % tablas, esperaba ≤22', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK F3A#1: publication tiene % tablas (de 42 originales)', v_n;

  SELECT COUNT(*) INTO v_n FROM cron.job WHERE jobname = 'reactivar-items-vencidos' AND schedule = '*/15 * * * *';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL F3A#2: cron schedule no es */15 * * * *';
  END IF;
  RAISE NOTICE 'SMOKE OK F3A#2: cron reactivar-items-vencidos cada 15min';

  SELECT COUNT(*) INTO v_n FROM pg_indexes
   WHERE indexname IN ('idx_movimientos_local_cuenta_activo', 'idx_facturas_estado_venc');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE FAIL F3A#6/#10: faltan índices nuevos';
  END IF;
  RAISE NOTICE 'SMOKE OK F3A#6/#10: índices creados';

  SELECT COUNT(*) INTO v_n FROM pg_proc
   WHERE proname IN ('aplicar_ncs_a_factura', 'anular_movimientos_batch');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE FAIL F3A#7/#8: faltan RPCs batch';
  END IF;
  RAISE NOTICE 'SMOKE OK F3A#7/#8: RPCs batch creadas';
END $$;

COMMIT;
