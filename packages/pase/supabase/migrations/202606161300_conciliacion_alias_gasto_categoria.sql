-- 202606161300_conciliacion_alias_gasto_categoria.sql
-- Lucas 16-jun: "tengo varios GASTOS que no son de proveedor sino impuestos
-- (el impuesto de MP a débitos/créditos), no puedo asociarlos a un proveedor,
-- y eso hace que tenga que pasar 1 por 1 porque no aprende como cuando tocás
-- 'pertenece a proveedor'".
--
-- Fix: el alias de conciliación (conciliacion_alias) aprende, además del
-- titular→gasto_directo que ya guardaba, la CATEGORÍA y el TIPO del gasto. Así
-- la próxima conciliación reconoce el titular y pre-clasifica la fila roja como
-- "gasto conocido" → se crea de un clic (o todos juntos), sin pasar 1x1.
--
-- Dos RPCs nuevas:
--   - fn_aprender_gasto_alias: se llama al crear un gasto desde la conciliación
--     (aprendizaje inmediato, no espera al cierre).
--   - fn_clasificar_gastos_conocidos: el front le pasa las descripciones de las
--     filas rojas y devuelve, para las que ya conoce, su categoría/tipo.
--
-- NO toca fn_cruzar_extracto_mp (función grande/sensible) — el recall vive en
-- una RPC chica aparte que el front llama tras cargar el cruce.

ALTER TABLE conciliacion_alias
  ADD COLUMN IF NOT EXISTS gasto_categoria TEXT,
  ADD COLUMN IF NOT EXISTS gasto_tipo      TEXT;

COMMENT ON COLUMN conciliacion_alias.gasto_categoria IS
  'Para alias tipo=gasto_directo: categoría aprendida del gasto (ej: OTROS IMPUESTOS). Permite pre-clasificar filas rojas conocidas.';
COMMENT ON COLUMN conciliacion_alias.gasto_tipo IS
  'Para alias tipo=gasto_directo: etiqueta de tipo aprendida (ej: Impuesto). Se pasa a crear_gasto al recrear.';

-- ── Aprender (upsert) titular→gasto_directo con categoría/tipo ───────────────
CREATE OR REPLACE FUNCTION fn_aprender_gasto_alias(
  p_local_id    INTEGER,
  p_descripcion TEXT,
  p_categoria   TEXT,
  p_tipo        TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant  UUID;
  v_titular TEXT;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;
  PERFORM _validar_local_autorizado(p_local_id);

  v_titular := fn_extraer_titular(p_descripcion);
  -- Titulares muy cortos no son identificables — no se aprenden (evita ruido).
  IF v_titular IS NULL OR LENGTH(v_titular) < 4 THEN RETURN; END IF;
  IF p_categoria IS NULL OR p_categoria = '' THEN RETURN; END IF;

  INSERT INTO conciliacion_alias
    (tenant_id, local_id, titular, tipo, gasto_categoria, gasto_tipo)
  VALUES
    (v_tenant, p_local_id, v_titular, 'gasto_directo', p_categoria, NULLIF(p_tipo, ''))
  ON CONFLICT (tenant_id, local_id, titular) DO UPDATE
    SET tipo            = 'gasto_directo',
        gasto_categoria = EXCLUDED.gasto_categoria,
        gasto_tipo      = EXCLUDED.gasto_tipo,
        prov_id         = NULL,  -- pasó a ser gasto, ya no proveedor
        veces           = conciliacion_alias.veces + 1,
        updated_at      = NOW();
END;
$$;

REVOKE ALL ON FUNCTION fn_aprender_gasto_alias(INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_aprender_gasto_alias(INTEGER, TEXT, TEXT, TEXT) TO authenticated;

-- ── Recuperar clasificación conocida para un conjunto de descripciones ───────
-- Devuelve una fila por cada descripción que YA tiene alias gasto_directo con
-- categoría aprendida (las que no conoce, no aparecen).
CREATE OR REPLACE FUNCTION fn_clasificar_gastos_conocidos(
  p_local_id      INTEGER,
  p_descripciones TEXT[]
) RETURNS TABLE (descripcion TEXT, categoria TEXT, tipo TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;

  RETURN QUERY
  SELECT DISTINCT d.descripcion, a.gasto_categoria, a.gasto_tipo
  FROM unnest(p_descripciones) AS d(descripcion)
  JOIN conciliacion_alias a
    ON a.tenant_id = v_tenant
   AND a.local_id  = p_local_id
   AND a.tipo      = 'gasto_directo'
   AND a.gasto_categoria IS NOT NULL
   AND a.titular = fn_extraer_titular(d.descripcion);
END;
$$;

REVOKE ALL ON FUNCTION fn_clasificar_gastos_conocidos(INTEGER, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_clasificar_gastos_conocidos(INTEGER, TEXT[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
