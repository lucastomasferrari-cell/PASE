-- 202606110700_normalizar_sufijos_y_r4_alias.sql
-- Lucas 10-jun: 2 bugs encontrados en la conciliación de mayo Rene.
--
-- BUG 1: fn_extraer_titular NO quita sufijos comerciales (S.A, SRL, SAS,
--        SACIF, LTDA, SH, etc.) → "Bodegas Esmeralda" (transferencia MP)
--        != "BODEGAS ESMERALDA S.A" (proveedor) → no matchean → no se
--        agrupa.
--
-- BUG 2: fn_cruzar_extracto_mp paso R4 solo itera por proveedores que
--        tienen pagos en _ce_mov. Si un proveedor tiene alias precargado
--        (FALCON ESTEBAN CARLOS, sin pagos en mayo), R4 nunca lo procesa
--        → no se forma bloque → queda como suelto.
--
-- Fix:
--  1. Extender fn_extraer_titular para quitar sufijos comerciales AR.
--  2. Re-seedear todos los aliases generados automáticamente (veces=0)
--     con la normalización nueva. Los aliases manuales / aprendidos
--     (veces>0) NO se tocan (respeta decisiones del usuario).
--  3. Modificar R4 para que también itere por proveedores referenciados
--     por aliases (con prov_id NOT NULL) presentes en _ce_ext, aunque no
--     tengan pagos en _ce_mov. Bloque con n_pagos=0 + suma_pase=0.

-- ── 1. Mejorar fn_extraer_titular ──────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_extraer_titular(p_desc TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(TRIM(regexp_replace(
    regexp_replace(
      regexp_replace(
        unaccent(UPPER(COALESCE(p_desc, ''))),
        -- (a) prefijos operativos MP
        '^(TRANSFERENCIA (ENVIADA|RECIBIDA)|PAGO CON QR|PAGO DE (SERVICIO|SUSCRIPCION)|DEBITO POR DEUDA|COMPRA|PAGO)\s*',
        ''
      ),
      -- (b) sufijos comerciales (al final). Acepta puntos, espacios y
      -- variantes: "S.A", "S A", "SA", "S.A.", "SRL", "S.R.L", "S R L",
      -- "SAS", "S.A.S", "SACIF", "SACI", "SH" (sociedad de hecho),
      -- "LTDA", "LIMITADA". El \M es word boundary (final de palabra),
      -- garantiza que solo machee al final.
      '\s+(S[\s\.]*A[\s\.]*(C[\s\.]*I[\s\.]*F?)?|S[\s\.]*R[\s\.]*L|S[\s\.]*A[\s\.]*S|S[\s\.]*H|LTDA\.?|LIMITADA)\s*$',
      '',
      'i'
    ),
    '\s+', ' ', 'g'
  )), '');
$$;

-- ── 2. Re-seedear los aliases generados automáticamente ────────────────
-- Los manuales (veces > 0 — significa que el usuario los cerró o el
-- sistema los aprendió en un cierre) NO se tocan. Sólo los del seed
-- automático (veces = 0) se borran y re-crean con la normalización nueva.
DELETE FROM conciliacion_alias WHERE veces = 0;

DO $$
DECLARE v_pid INTEGER; v_count INTEGER := 0; BEGIN
  FOR v_pid IN SELECT id FROM proveedores WHERE estado = 'Activo'
  LOOP
    PERFORM fn_seed_alias_proveedor(v_pid);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Re-seed alias proveedor con sufijos quitados: % proveedores procesados', v_count;
END $$;

NOTIFY pgrst, 'reload schema';
