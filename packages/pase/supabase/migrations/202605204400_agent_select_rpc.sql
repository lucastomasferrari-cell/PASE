-- ═══════════════════════════════════════════════════════════════════════════
-- RPC fn_agent_select — query DB read-only para el auto-fix agent
--
-- Permite que el script auto-fix-agent.mjs inspeccione el schema y datos
-- de Postgres directamente (FKs, columnas, RLS policies, sample data, etc.).
--
-- Sin esto, el agent solo veía código TypeScript y se le escapaban bugs de
-- backend como el de la FK facturas.prov_id → proveedores.id que rompía
-- queries y el síntoma se manifestaba 3 capas arriba en el frontend.
--
-- Restricciones:
--   - Solo SELECT y WITH (CTEs).
--   - Se aborta si detecta keywords destructivos (INSERT/UPDATE/DELETE/DROP/
--     ALTER/TRUNCATE/CREATE/GRANT/REVOKE/COPY).
--   - Resultado limitado a 100 rows.
--   - Timeout de 10 segundos.
--   - GRANT solo a service_role (no anon ni authenticated). El agent usa
--     SERVICE_KEY desde GitHub Actions.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_agent_select(p_sql TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_upper TEXT;
  v_sql_lim TEXT;
  v_result JSONB;
  v_banned TEXT[] := ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
    'CREATE', 'GRANT', 'REVOKE', 'COPY', 'CALL', 'DO'
  ];
  v_kw TEXT;
BEGIN
  IF p_sql IS NULL OR length(trim(p_sql)) = 0 THEN
    RAISE EXCEPTION 'SQL_VACIO';
  END IF;

  v_upper := upper(trim(p_sql));

  -- Debe empezar con SELECT o WITH (CTE)
  IF NOT (v_upper LIKE 'SELECT%' OR v_upper LIKE 'WITH%' OR v_upper LIKE '(SELECT%') THEN
    RAISE EXCEPTION 'SOLO_SELECT_O_WITH';
  END IF;

  -- Buscar keywords destructivos como palabras completas. Usamos \m \M
  -- (Postgres word boundaries) en lugar de \b (POSIX no lo soporta).
  FOREACH v_kw IN ARRAY v_banned LOOP
    IF v_upper ~ ('\m' || v_kw || '\M') THEN
      RAISE EXCEPTION 'KEYWORD_DESTRUCTIVO_DETECTADO: %', v_kw;
    END IF;
  END LOOP;

  -- Forzar LIMIT 100 si no tiene LIMIT explícito.
  IF v_upper ~ '\mLIMIT\M' THEN
    v_sql_lim := trim(both ';' from trim(p_sql));
  ELSE
    v_sql_lim := trim(both ';' from trim(p_sql)) || ' LIMIT 100';
  END IF;

  -- Ejecutar con timeout 10s
  EXECUTE 'SET LOCAL statement_timeout = 10000';
  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || v_sql_lim || ') t' INTO v_result;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Solo service_role puede llamar esta función. El agent script usa
-- SUPABASE_SERVICE_KEY desde GitHub Actions.
REVOKE ALL ON FUNCTION fn_agent_select(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_agent_select(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION fn_agent_select(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION fn_agent_select(TEXT) TO service_role;

COMMENT ON FUNCTION fn_agent_select(TEXT) IS
  'Query DB read-only para auto-fix agent. Solo SELECT/WITH. LIMIT 100 forzado. Timeout 10s. GRANT solo a service_role.';

NOTIFY pgrst, 'reload schema';
