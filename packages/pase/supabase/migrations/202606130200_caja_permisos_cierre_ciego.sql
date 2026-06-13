-- ═══════════════════════════════════════════════════════════════════════════
-- Tier 2 (a) — Cierre de caja CIEGO por default (2026-06-13)
--
-- Contexto (plan docs/superpowers/plans/2026-06-12-caja-comanda-tier2.md):
--   * Las RPCs de caja chequean fn_check_perm_comanda('comanda.caja.abrir' /
--     'comanda.caja.cerrar' / 'comanda.caja.movimientos') desde sprint 2
--     (202605051800), pero esos slugs NUNCA se seedearon en rol_pos_permisos
--     (202605151740 solo seedeó ventas/reportes/etc; dueno tiene '*').
--   * Slug NUEVO: 'comanda.caja.ver_esperado_cierre' — quien lo tiene ve el
--     esperado/totales por método ANTES de declarar. Quien NO lo tiene cuenta
--     a ciegas (modelo Toast). El CAJERO no lo recibe a propósito.
--   * La vista post-cierre (calculado + diferencia que devuelve
--     fn_cerrar_turno_caja_comanda) es igual para todos — el ciego es ANTES
--     de declarar, no después.
--
-- Verificado antes de escribir:
--   * rol_pos_permisos: UNIQUE (rol_pos, slug) [uniq_rol_pos_slug]
--     → ON CONFLICT (rol_pos, slug).
--   * Catálogo comanda_permisos_catalogo (202605240000, slug PK): NO tiene
--     los slugs de caja → se registran acá con descripción (categoria 'caja').
--   * Ningún seed previo incluye slugs comanda.caja.* en rol_pos_permisos.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Seed rol_pos_permisos: permisos de caja por rol ────────────────────
-- Permisos que las RPCs ya chequean pero nunca se seedearon,
-- + el permiso nuevo: VER el esperado al cerrar (sin él, cierre CIEGO).
INSERT INTO rol_pos_permisos (rol_pos, slug) VALUES
  ('cajero',    'comanda.caja.abrir'),
  ('cajero',    'comanda.caja.cerrar'),
  ('encargado', 'comanda.caja.abrir'),
  ('encargado', 'comanda.caja.cerrar'),
  ('encargado', 'comanda.caja.movimientos'),
  ('encargado', 'comanda.caja.ver_esperado_cierre'),
  ('manager',   'comanda.caja.abrir'),
  ('manager',   'comanda.caja.cerrar'),
  ('manager',   'comanda.caja.movimientos'),
  ('manager',   'comanda.caja.ver_esperado_cierre')
ON CONFLICT (rol_pos, slug) DO NOTHING;
-- dueno ya tiene '*'. El CAJERO no recibe ver_esperado_cierre: cuenta a ciegas.

-- ─── 2. Catálogo de slugs (referencia para la UI de usuarios POS) ──────────
INSERT INTO comanda_permisos_catalogo (slug, descripcion, categoria, orden) VALUES
  ('comanda.caja.abrir',               'Abrir turno de caja',                                        'caja', 10),
  ('comanda.caja.movimientos',         'Registrar retiro / depósito / ajuste de caja',               'caja', 20),
  ('comanda.caja.cerrar',              'Cerrar turno de caja + arqueo',                              'caja', 30),
  ('comanda.caja.ver_esperado_cierre', 'Ver el efectivo esperado ANTES de declarar el cierre (sin esto, cierre ciego)', 'caja', 40)
ON CONFLICT (slug) DO NOTHING;

-- ─── Smoke test ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n INT;
BEGIN
  SELECT COUNT(*) INTO v_n FROM rol_pos_permisos
  WHERE slug LIKE 'comanda.caja.%' AND activo = TRUE;
  IF v_n < 10 THEN
    RAISE EXCEPTION 'SMOKE FAIL: esperaba >=10 rows comanda.caja.* en rol_pos_permisos (got %)', v_n;
  END IF;

  SELECT COUNT(*) INTO v_n FROM rol_pos_permisos
  WHERE rol_pos = 'cajero' AND slug = 'comanda.caja.ver_esperado_cierre';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: cajero NO debe tener ver_esperado_cierre';
  END IF;

  SELECT COUNT(*) INTO v_n FROM comanda_permisos_catalogo
  WHERE slug = 'comanda.caja.ver_esperado_cierre';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL: ver_esperado_cierre ausente del catálogo';
  END IF;

  RAISE NOTICE 'SMOKE OK: permisos de caja seedeados, cajero queda ciego al esperado';
END $$;

COMMIT;
