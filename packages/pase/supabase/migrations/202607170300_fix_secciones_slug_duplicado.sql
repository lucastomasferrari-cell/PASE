-- ============================================================
-- 202607170300_fix_secciones_slug_duplicado.sql
-- Separa dos pares de secciones que compartían el mismo permiso de
-- acceso ("seccionSlug"), causando visibilidad bidireccional no deseada:
--
--   Antes:                              Después:
--     Menú       ── comanda.catalogo.ver     Menú       ── comanda.catalogo.ver
--     Inventario ── comanda.catalogo.ver     Inventario ── comanda.inventario.ver (NUEVO)
--
--     Tienda propia    ── comanda.online.gestionar   Tienda propia    ── comanda.tienda.gestionar (NUEVO)
--     Canales digital  ── comanda.online.gestionar   Canales digital  ── comanda.online.gestionar
--
-- Migración de datos backward-compat: los users/roles que ya tenían el
-- slug viejo obtienen ADEMÁS el nuevo — ninguno pierde visibilidad.
-- Contexto: auditoría de permisos COMANDA (Lucas 17-jul).
-- ============================================================

BEGIN;

-- ─── Nuevo slug: comanda.inventario.ver (para sección Inventario) ────

-- 1a) Users individuales: quienes tenían catalogo.ver ahora también
--     obtienen inventario.ver (para no perder acceso a Inventario).
INSERT INTO comanda_usuario_permisos (comanda_usuario_id, modulo_slug, tenant_id)
SELECT DISTINCT cup.comanda_usuario_id, 'comanda.inventario.ver', cup.tenant_id
FROM comanda_usuario_permisos cup
WHERE cup.modulo_slug = 'comanda.catalogo.ver'
ON CONFLICT (comanda_usuario_id, modulo_slug) DO NOTHING;

-- 1b) Roles POS que tenían catalogo.ver → agregar inventario.ver.
INSERT INTO rol_pos_permisos (rol_pos, slug, activo)
SELECT DISTINCT rpp.rol_pos, 'comanda.inventario.ver', true
FROM rol_pos_permisos rpp
WHERE rpp.slug = 'comanda.catalogo.ver' AND rpp.activo = true
ON CONFLICT DO NOTHING;

-- ─── Nuevo slug: comanda.tienda.gestionar (para Tienda propia) ───────

-- 2a) Users con online.gestionar → agregar tienda.gestionar.
INSERT INTO comanda_usuario_permisos (comanda_usuario_id, modulo_slug, tenant_id)
SELECT DISTINCT cup.comanda_usuario_id, 'comanda.tienda.gestionar', cup.tenant_id
FROM comanda_usuario_permisos cup
WHERE cup.modulo_slug = 'comanda.online.gestionar'
ON CONFLICT (comanda_usuario_id, modulo_slug) DO NOTHING;

-- 2b) Roles POS con online.gestionar → agregar tienda.gestionar.
INSERT INTO rol_pos_permisos (rol_pos, slug, activo)
SELECT DISTINCT rpp.rol_pos, 'comanda.tienda.gestionar', true
FROM rol_pos_permisos rpp
WHERE rpp.slug = 'comanda.online.gestionar' AND rpp.activo = true
ON CONFLICT DO NOTHING;

COMMIT;
