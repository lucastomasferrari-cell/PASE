-- 202606040900_movimientos_created_at.sql
-- Bug reportado Lucas 03-jun: en Caja → Movimientos con orden "Fecha de
-- carga" descendente, los Ajustes Iniciales aparecen siempre arriba aunque
-- sean del 30/4/2026 y los demás movs sean del 3/6/2026.
--
-- Causa raíz: el orden es por `id DESC` lexicográfico. Los ids tienen
-- formato mixto:
--   - Normales: "MOV-1780535089-ba4f"
--   - Ajustes:  "MOV-AJUSTE-1779571852960-aqz1e"
-- Lexicográficamente "MOV-A..." > "MOV-1..." porque la "A" (codepoint 65)
-- es mayor que "1" (codepoint 49). Resultado: los AJUSTE siempre arriba.
--
-- Fix: agregar columna `created_at TIMESTAMPTZ` con DEFAULT NOW() para
-- los inserts futuros. Backfill para rows existentes parseando el
-- timestamp del id si matchea, sino usar `fecha` como fallback.
--
-- Después el frontend ordena por `created_at` (que sí es timestamp real)
-- en lugar de por `id` (que es string lexicográfico).

ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill: parsear el timestamp del id (soporta los 3 formatos).
-- IMPORTANTE: skipea filas con tenant_id huérfano (apunta a tenant
-- borrado). El trigger fn_trg_sync_saldos_caja se dispara en cada
-- UPDATE y tira FK violation si el tenant no existe en tenants.
-- Los huérfanos quedan con created_at = NOW() (default) pero como
-- son de un tenant borrado, nadie los va a ver.
UPDATE movimientos
   SET created_at = CASE
     -- Formato 1: "MOV-AJUSTE-{ms}-{rand}" (13 dígitos = ms)
     WHEN id ~ '^MOV-AJUSTE-(\d{13})-' THEN
       to_timestamp(substring(id from '^MOV-AJUSTE-(\d+)-')::bigint / 1000.0)
     -- Formato 2: "MOV-{unix}-{rand}" (10 dígitos = segundos)
     WHEN id ~ '^MOV-(\d{10})-' THEN
       to_timestamp(substring(id from '^MOV-(\d+)-')::bigint)
     -- Formato 3: "MOV-{ms}-{rand}" (13 dígitos = ms, sin AJUSTE)
     WHEN id ~ '^MOV-(\d{13})-' THEN
       to_timestamp(substring(id from '^MOV-(\d+)-')::bigint / 1000.0)
     -- Formato OB-... (opening balance, formato legacy completamente
     -- distinto). Fallback: usar fecha del movimiento.
     ELSE fecha::timestamptz
   END
 WHERE id IS NOT NULL
   AND tenant_id IN (SELECT id FROM tenants);

-- Index para que el ORDER BY created_at DESC sea eficiente.
CREATE INDEX IF NOT EXISTS idx_movimientos_created_at_desc
  ON movimientos (tenant_id, created_at DESC);

COMMENT ON COLUMN movimientos.created_at IS
  'Timestamp real de inserción. Reemplaza el orden lexicográfico por id ' ||
  'que ponía siempre los AJUSTE primero (commit 2026-06-04).';

NOTIFY pgrst, 'reload schema';
