-- ═══════════════════════════════════════════════════════════════════════════
-- Cambiar auditoria.tenant_id FK de NO ACTION (default) a ON DELETE CASCADE.
--
-- Contexto: la FK se creó en migration 202604281201 como
--   ALTER TABLE auditoria ADD COLUMN tenant_id uuid REFERENCES tenants(id);
-- Sin ON DELETE explícito → Postgres usa NO ACTION → bloquea DELETE FROM
-- tenants cuando hay filas de auditoria que la referencian.
--
-- Síntoma: cleanup del test restore_tenant_mutante quedaba bloqueado porque
-- la RPC restore_tenant inserta una fila en auditoria (RESTORE_TENANT) que
-- el client no puede borrar (triggers append-only).
--
-- Con CASCADE, borrar un tenant arrastra sus filas de auditoria. Trade-off
-- forense aceptado: borrar un tenant es una acción explícita y poco común;
-- el snapshot de backup ya cubre la recuperación histórica si hace falta.
-- ═══════════════════════════════════════════════════════════════════════════

-- Verificar pre-condición: la FK existe con el nombre esperado
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'auditoria_tenant_id_fkey'
       AND table_name = 'auditoria'
       AND constraint_type = 'FOREIGN KEY'
  ) THEN
    RAISE EXCEPTION 'FK auditoria_tenant_id_fkey no existe — investigar antes de re-crear';
  END IF;
END $$;

-- Drop + recreate con CASCADE
ALTER TABLE auditoria DROP CONSTRAINT auditoria_tenant_id_fkey;
ALTER TABLE auditoria
  ADD CONSTRAINT auditoria_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
