-- ═══════════════════════════════════════════════════════════════════════════
-- Simplificar policy rrhh_ad_scope_all sobre rrhh_adelantos.
--
-- En task 0.2 cerramos la policy con cast e.id::text = empleado_id::text
-- porque otras tablas hijas tenían empleado_id text. En 0.5 confirmamos que
-- rrhh_adelantos.empleado_id ya era uuid, así que el cast es innecesario:
-- e.id (uuid) = empleado_id (uuid) directo.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "rrhh_ad_scope_all" ON public.rrhh_adelantos;
CREATE POLICY "rrhh_ad_scope_all" ON public.rrhh_adelantos
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e
                 WHERE e.id = rrhh_adelantos.empleado_id
                 AND (auth_es_dueno_o_admin()
                      OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e
                      WHERE e.id = rrhh_adelantos.empleado_id
                      AND (auth_es_dueno_o_admin()
                           OR e.local_id = ANY(auth_locales_visibles()))));
