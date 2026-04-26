-- ═══════════════════════════════════════════════════════════════════════════
-- Deprecar la tabla legacy `empleados` y formalizar las FKs hacia
-- rrhh_empleados (la canónica).
--
-- Estado pre-migration (validado por diagnóstico Q1-Q6):
--   - empleados:                    0 filas
--   - empleado_archivos:            0 filas (empleado_id integer)
--   - rrhh_documentos:              0 filas (empleado_id text)
--   - rrhh_historial_sueldos:       0 filas (empleado_id text)
--   - rrhh_pagos_especiales:        0 filas (empleado_id text)
--   - rrhh_empleados:               4 filas
-- Q1 (empleados huérfanos): 0. Q5/Q6 (valores no-uuid o huérfanos): 0.
--
-- Por eso los UPDATE de migración de datos quedan no-op y el ALTER TYPE
-- text → uuid es instantáneo. La salvaguarda RAISE EXCEPTION queda igual
-- como protección si alguien re-aplica la migration sobre un schema con
-- datos.
-- ═══════════════════════════════════════════════════════════════════════════

-- 0. Drop policies que referencian las columnas empleado_id antes de
--    tocarlas. Postgres no deja ALTER TYPE / DROP COLUMN si una policy
--    depende de la columna. Las recreamos al final apuntadas a
--    rrhh_empleados (la nueva tabla padre) y, donde corresponde,
--    simplificadas sin el cast ::text que existía mientras la columna
--    era text.
DROP POLICY IF EXISTS "ea_scope_all" ON public.empleado_archivos;
DROP POLICY IF EXISTS "rrhh_doc_scope_all" ON public.rrhh_documentos;
DROP POLICY IF EXISTS "rrhh_hs_scope_all" ON public.rrhh_historial_sueldos;
DROP POLICY IF EXISTS "rrhh_pe_scope_all" ON public.rrhh_pagos_especiales;

-- 1. Migrar empleado_archivos.empleado_id (int → uuid).
ALTER TABLE empleado_archivos ADD COLUMN empleado_id_new uuid;

UPDATE empleado_archivos ea
SET empleado_id_new = re.id
FROM empleados e
JOIN rrhh_empleados re
  ON re.local_id = e.local_id
  AND (re.apellido || ' ' || re.nombre) ILIKE '%' || e.nombre || '%'
WHERE ea.empleado_id = e.id;

DO $$
DECLARE v_orfanos int;
BEGIN
  SELECT COUNT(*) INTO v_orfanos FROM empleado_archivos
  WHERE empleado_id IS NOT NULL AND empleado_id_new IS NULL;
  IF v_orfanos > 0 THEN
    RAISE EXCEPTION 'EMPLEADO_ARCHIVOS_HUERFANOS: % filas no mapeables', v_orfanos;
  END IF;
END $$;

-- Drop FK vieja si existe (por nombre estándar), después swap de columnas.
ALTER TABLE empleado_archivos
  DROP CONSTRAINT IF EXISTS empleado_archivos_empleado_id_fkey;
ALTER TABLE empleado_archivos DROP COLUMN empleado_id;
ALTER TABLE empleado_archivos RENAME COLUMN empleado_id_new TO empleado_id;
ALTER TABLE empleado_archivos ADD CONSTRAINT
  empleado_archivos_empleado_id_fkey
  FOREIGN KEY (empleado_id) REFERENCES rrhh_empleados(id)
  ON DELETE CASCADE;

-- 2. Migrar 3 columnas empleado_id text → uuid + FK formal.
ALTER TABLE rrhh_documentos
  ALTER COLUMN empleado_id TYPE uuid USING empleado_id::uuid;
ALTER TABLE rrhh_documentos ADD CONSTRAINT
  rrhh_documentos_empleado_id_fkey
  FOREIGN KEY (empleado_id) REFERENCES rrhh_empleados(id)
  ON DELETE CASCADE;

ALTER TABLE rrhh_historial_sueldos
  ALTER COLUMN empleado_id TYPE uuid USING empleado_id::uuid;
ALTER TABLE rrhh_historial_sueldos ADD CONSTRAINT
  rrhh_historial_sueldos_empleado_id_fkey
  FOREIGN KEY (empleado_id) REFERENCES rrhh_empleados(id)
  ON DELETE CASCADE;

ALTER TABLE rrhh_pagos_especiales
  ALTER COLUMN empleado_id TYPE uuid USING empleado_id::uuid;
ALTER TABLE rrhh_pagos_especiales ADD CONSTRAINT
  rrhh_pagos_especiales_empleado_id_fkey
  FOREIGN KEY (empleado_id) REFERENCES rrhh_empleados(id)
  ON DELETE CASCADE;

-- 3. Recrear policies apuntando a rrhh_empleados con e.id = empleado_id
--    (sin cast ::text — ahora ambos son uuid).
CREATE POLICY "ea_scope_all" ON public.empleado_archivos
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e
                 WHERE e.id = empleado_archivos.empleado_id
                 AND (auth_es_dueno_o_admin()
                      OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e
                      WHERE e.id = empleado_archivos.empleado_id
                      AND (auth_es_dueno_o_admin()
                           OR e.local_id = ANY(auth_locales_visibles()))));

CREATE POLICY "rrhh_doc_scope_all" ON public.rrhh_documentos
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e
                 WHERE e.id = rrhh_documentos.empleado_id
                 AND (auth_es_dueno_o_admin()
                      OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e
                      WHERE e.id = rrhh_documentos.empleado_id
                      AND (auth_es_dueno_o_admin()
                           OR e.local_id = ANY(auth_locales_visibles()))));

CREATE POLICY "rrhh_hs_scope_all" ON public.rrhh_historial_sueldos
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e
                 WHERE e.id = rrhh_historial_sueldos.empleado_id
                 AND (auth_es_dueno_o_admin()
                      OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e
                      WHERE e.id = rrhh_historial_sueldos.empleado_id
                      AND (auth_es_dueno_o_admin()
                           OR e.local_id = ANY(auth_locales_visibles()))));

CREATE POLICY "rrhh_pe_scope_all" ON public.rrhh_pagos_especiales
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM rrhh_empleados e
                 WHERE e.id = rrhh_pagos_especiales.empleado_id
                 AND (auth_es_dueno_o_admin()
                      OR e.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM rrhh_empleados e
                      WHERE e.id = rrhh_pagos_especiales.empleado_id
                      AND (auth_es_dueno_o_admin()
                           OR e.local_id = ANY(auth_locales_visibles()))));

-- 4. Drop tabla empleados (CASCADE por si quedan dependencias residuales).
DROP TABLE empleados CASCADE;
