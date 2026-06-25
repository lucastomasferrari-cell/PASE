-- ═══════════════════════════════════════════════════════════════════════════
-- Limpieza de datos DEMO/prueba sembrados en desarrollo — 25-jun-2026
--
-- Saca de la vista los clientes y reservas de prueba (mails @example.com,
-- teléfonos secuenciales). Soft-delete (deleted_at) para no romper FKs.
-- No son datos reales del negocio; eran seed de desarrollo.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Reservas de los clientes demo (por email directo o por cliente_id).
UPDATE reservas
   SET deleted_at = NOW()
 WHERE deleted_at IS NULL
   AND (cliente_email ILIKE '%@example.com'
        OR cliente_id IN (SELECT id FROM clientes WHERE email ILIKE '%@example.com'));

-- 2) Los clientes demo.
UPDATE clientes
   SET deleted_at = NOW()
 WHERE deleted_at IS NULL
   AND email ILIKE '%@example.com';
