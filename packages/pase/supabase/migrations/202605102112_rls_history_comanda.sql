-- ═══════════════════════════════════════════════════════════════════════════
-- RLS para las 3 tablas history de COMANDA (items_history,
-- item_precios_canal_history, canales_history).
--
-- Fecha:    2026-05-10
-- Origen:   Hallazgo del Supabase Database Linter (al planear el roadmap
--           de seguridad incremental, plan sunny-creek). Estas 3 tablas
--           fueron creadas en 202605051200_comanda_sprint_1.sql sin RLS.
-- Plan:     CLAUDE.md → Convenciones para features nuevas → Capa 2b L5-L7.
--
-- Approach: derivar tenant_id desde old_data JSONB (las 3 tablas no tienen
-- columna tenant_id propia; el row antes/después se guarda completo en
-- old_data/new_data como JSONB, y las tablas padre todas tienen tenant_id
-- NOT NULL → la key existe siempre).
--
-- Append-only por arquitectura: nadie (ni el dueño) puede UPDATE/DELETE
-- filas de history. Solo el trigger fn_<tabla>_audit() las inserta —
-- pasamos esos 3 a SECURITY DEFINER para que bypass RLS en el INSERT
-- (sin esto, las UPDATEs de las tablas padre fallarían al cascadear).
--
-- Patrón canónico PASE: auth_es_superadmin() OR (tenant_id check).
-- Sin filtro local_id porque las history son tenant-wide (las tablas
-- padre pueden tener local_id IS NULL = catálogo del tenant).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Habilitar RLS ──────────────────────────────────────────────────────

ALTER TABLE items_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_precios_canal_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE canales_history ENABLE ROW LEVEL SECURITY;

-- ─── 2. Policies SELECT (única operación permitida a authenticated) ───────

DROP POLICY IF EXISTS "items_history_select" ON items_history;
CREATE POLICY "items_history_select" ON items_history FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (old_data->>'tenant_id')::uuid = auth_tenant_id()
  );

DROP POLICY IF EXISTS "ipc_history_select" ON item_precios_canal_history;
CREATE POLICY "ipc_history_select" ON item_precios_canal_history FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (old_data->>'tenant_id')::uuid = auth_tenant_id()
  );

DROP POLICY IF EXISTS "canales_history_select" ON canales_history;
CREATE POLICY "canales_history_select" ON canales_history FOR SELECT TO authenticated
  USING (
    auth_es_superadmin()
    OR (old_data->>'tenant_id')::uuid = auth_tenant_id()
  );

-- ─── 3. Trigger functions a SECURITY DEFINER ──────────────────────────────
-- Sin esto, las INSERTs del trigger se bloquearían por RLS (no hay INSERT
-- policy) → cascada: UPDATE de items/canales/item_precios_canal rollback →
-- app rota. SECURITY DEFINER bypassa RLS para el INSERT al history.
-- search_path = public es la convención del repo para SECURITY DEFINER
-- (previene search_path injection — patrón usado en fn_recalcular_saldo_proveedor
-- y otros triggers SECURITY DEFINER del repo).

ALTER FUNCTION fn_items_audit() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION fn_ipc_audit() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION fn_canales_audit() SECURITY DEFINER SET search_path = public;

-- ─── Notas para el futuro ─────────────────────────────────────────────────
-- - Append-only estricto: NO hay policies INSERT/UPDATE/DELETE para
--   authenticated → bloqueadas por default. Cumple WORM (write-once-read-many).
-- - Si más adelante el volumen de history crece y el cast JSONB en cada SELECT
--   se vuelve lento, considerar agregar columna tenant_id directa + backfill
--   + índice (Approach B del plan sunny-creek). Hoy con COMANDA pre-launch
--   no aplica.
-- - Test E2E mutante de aislamiento entre tenants: diferido a Sprint A
--   (requiere tenant secundario, hoy con un solo tenant Neko no es testeable).
