-- 202606102200_conciliacion_alias.sql
-- Lucas 10-jun: "los fixes no tienen que ser parches tipo 'antonella ≠
-- armando', sino la solución que aplique a todos los problemas similares".
--
-- Problema de clase: el titular de la cuenta MP NO es identificable por
-- nombre de forma confiable. "Eduardo Marino" ES el proveedor FUNES;
-- "Marlon Suescun" ES el proveedor Suescun Fabian Ariel; pero "Baldi
-- Antonella" (retiro de la dueña) NO es el proveedor ARMANDO MARIO BALDI.
-- Ninguna heurística de texto distingue esos casos.
--
-- Solución general: ALIAS APRENDIDOS (patrón compras_mapeo de la bandeja
-- de conciliación). Al cerrar una conciliación, el sistema aprende de las
-- resoluciones del usuario:
--   - fila resuelta contra pagos de un proveedor → alias titular→proveedor
--   - fila resuelta con "Crear en Caja" → alias titular→gasto_directo
--     (= este titular no es proveedor de facturas; no buscar bloques)
--   - "ignorar" NO enseña (es decisión puntual del mes, no identidad)
-- En cruces futuros el alias MANDA; la heurística de tokens queda como
-- fallback solo para titulares nunca vistos.

CREATE TABLE IF NOT EXISTS conciliacion_alias (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_id    INTEGER NOT NULL,
  titular     TEXT NOT NULL,             -- normalizado (fn_extraer_titular)
  tipo        TEXT NOT NULL CHECK (tipo IN ('proveedor', 'gasto_directo')),
  prov_id     INTEGER NULL REFERENCES proveedores(id) ON DELETE CASCADE,
  veces       INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, titular)
);

ALTER TABLE conciliacion_alias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS concil_alias_all ON conciliacion_alias;
CREATE POLICY concil_alias_all ON conciliacion_alias
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- Extrae y normaliza el TITULAR de la descripción del extracto MP.
-- "Transferencia enviada Frig Marilu Damiano Srl" → "FRIG MARILU DAMIANO SRL"
-- "Pago con QR CERVECERIA Y MALTERIA QUILMES"     → "CERVECERIA Y MALTERIA QUILMES"
-- IMMUTABLE: puro string processing.
CREATE OR REPLACE FUNCTION fn_extraer_titular(p_desc TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(TRIM(regexp_replace(
    regexp_replace(
      unaccent(UPPER(COALESCE(p_desc, ''))),
      -- prefijos operativos de MP (en cualquier combinación inicial)
      '^(TRANSFERENCIA (ENVIADA|RECIBIDA)|PAGO CON QR|PAGO DE (SERVICIO|SUSCRIPCION)|DEBITO POR DEUDA|COMPRA|PAGO)\s*',
      ''
    ),
    '\s+', ' ', 'g'
  )), '');
$$;

COMMENT ON TABLE conciliacion_alias IS
  'Mapeo APRENDIDO titular-MP → proveedor/gasto_directo. Se alimenta al cerrar conciliaciones (fn_cerrar_conciliacion) y gobierna el matching de bloques/combos en fn_cruzar_extracto_mp. Patrón compras_mapeo (Lucas 10-jun).';

NOTIFY pgrst, 'reload schema';
