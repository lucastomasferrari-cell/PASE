-- ═══════════════════════════════════════════════════════════════════════════
-- Policies de storage.objects para el bucket 'facturas'.
-- Las existentes ("public read", "public upload") filtran por
-- bucket_id = 'empleados' → no aplicaban al bucket nuevo. Agregamos 4
-- policies explícitas (SELECT, INSERT, UPDATE, DELETE) para 'facturas',
-- todas sobre rol authenticated.
--
-- DELETE/UPDATE son necesarias porque el código del Lector IA hace
-- rollback del archivo (storage.remove) si el INSERT a facturas falla.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "facturas_upload" ON storage.objects;
CREATE POLICY "facturas_upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'facturas');

DROP POLICY IF EXISTS "facturas_read" ON storage.objects;
CREATE POLICY "facturas_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'facturas');

DROP POLICY IF EXISTS "facturas_update" ON storage.objects;
CREATE POLICY "facturas_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'facturas')
  WITH CHECK (bucket_id = 'facturas');

DROP POLICY IF EXISTS "facturas_delete" ON storage.objects;
CREATE POLICY "facturas_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'facturas');
