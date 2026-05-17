-- ═══════════════════════════════════════════════════════════════════════════
-- Migración de roles legacy → modelo simplificado (Lucas 2026-05-17)
--
-- Modelo nuevo: solo 2 niveles posibles:
--   - "dueno"    → acceso total (short-circuit "ve todo")
--   - "encargado" → matriz de permisos custom
--
-- Eliminamos los roles intermedios (admin / compras / cajero):
--   - "admin"    → "dueno"     (siempre vieron todo, sin diferencia funcional)
--   - "compras"  → "encargado" (su acceso pasa a vivir en la matriz de permisos)
--   - "cajero"   → "encargado" (idem)
--   - "superadmin" → NO se toca (cross-tenant, solo Lucas/Anthropic)
--
-- Antes de degradar "compras" o "cajero" a "encargado", garantizamos que sus
-- permisos efectivos del rol queden materializados en `usuario_permisos`
-- (porque encargado-puro sin permisos no ve nada). Si ya tenían rows en
-- usuario_permisos, no se agregan duplicados.
--
-- Esta migración es IDEMPOTENTE — se puede correr varias veces sin romper nada.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Migrar admin → dueno (acceso total). Sin cambios en permisos (dueño
--    no necesita rows en usuario_permisos).
UPDATE usuarios
   SET rol = 'dueno'
 WHERE rol = 'admin';

-- 2. Para "compras" — materializar sus permisos del ROL antes de degradar:
--    compras → ['compras', 'remitos', 'proveedores', 'compras_anular']
INSERT INTO usuario_permisos (usuario_id, modulo_slug, tenant_id)
SELECT u.id, slug, u.tenant_id
  FROM usuarios u
  CROSS JOIN UNNEST(ARRAY['compras', 'remitos', 'proveedores', 'compras_anular']) AS slug
 WHERE u.rol = 'compras'
ON CONFLICT (usuario_id, modulo_slug) DO NOTHING;

UPDATE usuarios
   SET rol = 'encargado'
 WHERE rol = 'compras';

-- 3. Para "cajero" — idem: ['caja', 'caja_anular']
INSERT INTO usuario_permisos (usuario_id, modulo_slug, tenant_id)
SELECT u.id, slug, u.tenant_id
  FROM usuarios u
  CROSS JOIN UNNEST(ARRAY['caja', 'caja_anular']) AS slug
 WHERE u.rol = 'cajero'
ON CONFLICT (usuario_id, modulo_slug) DO NOTHING;

UPDATE usuarios
   SET rol = 'encargado'
 WHERE rol = 'cajero';

-- 4. Resumen post-migración (informativo — se ve en el output del SQL Editor).
DO $$
DECLARE
  v_duenos INTEGER;
  v_encargados INTEGER;
  v_otros INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_duenos FROM usuarios WHERE rol = 'dueno';
  SELECT COUNT(*) INTO v_encargados FROM usuarios WHERE rol = 'encargado';
  SELECT COUNT(*) INTO v_otros FROM usuarios WHERE rol NOT IN ('dueno', 'encargado', 'superadmin');
  RAISE NOTICE 'Migración roles completa:';
  RAISE NOTICE '  - Dueños/Admin: %', v_duenos;
  RAISE NOTICE '  - Encargados (matriz personalizada): %', v_encargados;
  RAISE NOTICE '  - Otros (debería ser 0 salvo superadmin): %', v_otros;
END $$;

NOTIFY pgrst, 'reload schema';
