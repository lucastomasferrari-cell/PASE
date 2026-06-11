-- ═══════════════════════════════════════════════════════════════════════════
-- Rol Socio: agregar permiso 'rentabilidad'
--
-- Lucas 11-jun: los socios deben ver ventas y reportes en tiempo real. El rol
-- sistema Socio (migración 202605201900) ya incluye dashboard, negocio,
-- finanzas, objetivos, eerr (pantalla "Reportes"), cierre, cashflow y
-- ventas_historico — pero le faltaba 'rentabilidad' (pantalla Rentabilidad,
-- sección Dirección). Las ventas en vivo se ven en Inicio/Negocio/Finanzas,
-- todas ya cubiertas.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO rol_permisos (rol_id, modulo_slug)
SELECT r.id, 'rentabilidad'
  FROM roles r
 WHERE r.slug = 'socio' AND r.tenant_id IS NULL AND r.es_sistema
ON CONFLICT DO NOTHING;

-- Smoke check: el rol socio debe tener ahora 'rentabilidad'.
DO $smoke$
DECLARE v_n integer;
BEGIN
  SELECT COUNT(*) INTO v_n
    FROM rol_permisos rp
    JOIN roles r ON r.id = rp.rol_id
   WHERE r.slug = 'socio' AND r.tenant_id IS NULL
     AND rp.modulo_slug = 'rentabilidad';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE FAIL: socio sin rentabilidad (n=%)', v_n;
  END IF;
  RAISE NOTICE 'SMOKE OK: rol socio tiene rentabilidad';
END $smoke$;
