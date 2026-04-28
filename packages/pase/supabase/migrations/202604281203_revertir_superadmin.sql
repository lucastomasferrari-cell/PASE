-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 0.15 — Revert de la promoción a superadmin del usuario id=1.
--
-- Decisión post-Etapa 1: el usuario id=1 ("dueno") es la cuenta diaria de
-- Lucas para operar Neko. NO debe ser su cuenta superadmin (que va a
-- crearse como usuario separado en Etapa 6 cuando esté listo el wizard
-- de superadmin en UI).
--
-- Esta migration revierte el bloque de promoción de Etapa 1
-- (202604281200_tenants_foundation.sql, paso 6) y restaura:
--   - usuarios.rol = 'dueno' para id=1.
--   - usuarios.tenant_id = uuid de Neko.
--   - tenant_admins gana la fila correspondiente (la migration de etapa 1
--     no la insertó porque al ejecutar el backfill, id=1 ya era superadmin
--     con tenant_id NULL y la query del INSERT lo excluía).
--
-- El sistema queda sin superadmin activo después de esta migration.
-- No es bloqueante: las etapas 2-3 son schema/RLS y no requieren superadmin
-- para funcionar. Etapa 6 onboarding crea el primer superadmin.
--
-- Aplicado vía flow oficial (vercel env pull + script Node con pg en
-- transacción + validaciones). Esta migration es la versión formal
-- versionada en repo.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Devolver id=1 a 'dueno' con tenant Neko.
UPDATE usuarios
   SET rol = 'dueno',
       tenant_id = (SELECT id FROM tenants WHERE slug='neko')
 WHERE id = 1;

-- 2. Restaurar fila en tenant_admins.
INSERT INTO tenant_admins (tenant_id, usuario_id, rol)
SELECT (SELECT id FROM tenants WHERE slug='neko'), 1, 'dueno'
ON CONFLICT (tenant_id, usuario_id) DO NOTHING;
