-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: FK faltantes facturas.prov_id y remitos.prov_id → proveedores.id
--
-- Bug reportado: queries del dashboard con nested select `proveedores(nombre)`
-- tiran HTTP 400 con PGRST200:
--   "Searched for a foreign key relationship between 'facturas' and
--    'proveedores' in the schema 'public', but no matches were found."
--
-- PostgREST necesita la FK declarada para resolver el nested select.
-- Verificado: 0 huérfanos en facturas (363/363 rows) y en remitos (todos OK)
-- → seguro agregar la FK sin tocar data.
--
-- Side effect positivo: la FK ahora impide INSERTs con prov_id inválido
-- (data integrity hardening).
-- ═══════════════════════════════════════════════════════════════════════════

-- facturas
ALTER TABLE facturas
  ADD CONSTRAINT facturas_prov_id_fkey
  FOREIGN KEY (prov_id) REFERENCES proveedores(id);

-- remitos
ALTER TABLE remitos
  ADD CONSTRAINT remitos_prov_id_fkey
  FOREIGN KEY (prov_id) REFERENCES proveedores(id);

NOTIFY pgrst, 'reload schema';
