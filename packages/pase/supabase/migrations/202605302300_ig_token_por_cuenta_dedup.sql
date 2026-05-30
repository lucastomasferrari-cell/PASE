-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta — get_ig_token POR CUENTA + dedup ig_config + UNIQUE
-- ─────────────────────────────────────────────────────────────────────────
--
-- CAUSA RAÍZ "el bot de Maneki no responde" (30-may, verificado contra prod):
--
-- 1) get_ig_token(p_tenant_id) recuperaba el token SOLO por tenant_id. Con
--    2 cuentas en el mismo tenant (Neko + Maneki) el SELECT ... INTO tomaba
--    una fila arbitraria. El bot de Maneki generaba la respuesta pero al
--    ENVIARLA usaba el token de Neko → Meta la rechazaba → Maneki "no
--    respondía". El texto quedaba en ig_mensajes como 'out' pero nunca
--    llegaba al usuario. Neko funcionaba porque su token era el recuperado.
--
-- 2) Había 32 filas duplicadas de Maneki porque el UNIQUE (tenant_id,
--    ig_account_id) NUNCA se aplicó (la migration fase 1 lo declaraba pero
--    no corrió en prod). Cada reconexión OAuth insertaba una fila nueva.
--
-- Ya aplicado en caliente (verificado: 31 filas borradas, constraint creado,
-- get_ig_token devuelve tokens distintos por cuenta). Esta migration deja
-- todo trackeado + idempotente.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Dedup: conservar MIN(id) por (tenant_id, ig_account_id).
--    Re-apuntar conversaciones de filas a borrar → fila conservada.
WITH keep AS (
  SELECT tenant_id, ig_account_id, MIN(id) AS keep_id
  FROM ig_config GROUP BY tenant_id, ig_account_id
)
UPDATE ig_conversaciones cv
SET ig_config_id = k.keep_id
FROM ig_config bad
JOIN keep k ON k.tenant_id = bad.tenant_id AND k.ig_account_id = bad.ig_account_id
WHERE cv.ig_config_id = bad.id AND bad.id <> k.keep_id;

DELETE FROM ig_config a USING ig_config b
WHERE a.tenant_id = b.tenant_id
  AND a.ig_account_id = b.ig_account_id
  AND a.id > b.id;

-- 2. UNIQUE constraint (idempotente).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ig_config'::regclass AND contype = 'u'
      AND conname = 'ig_config_tenant_account_uniq'
  ) THEN
    ALTER TABLE ig_config
      ADD CONSTRAINT ig_config_tenant_account_uniq UNIQUE (tenant_id, ig_account_id);
  END IF;
END $$;

-- 3. get_ig_token con filtro por cuenta. Backward compat: p_ig_account_id
--    opcional (NULL = comportamiento viejo, toma la cuenta de mayor id).
DROP FUNCTION IF EXISTS get_ig_token(uuid);

CREATE OR REPLACE FUNCTION get_ig_token(p_tenant_id uuid, p_ig_account_id text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_token text;
  v_encrypted bytea;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT auth_es_superadmin()
     AND (NOT auth_es_dueno_o_admin() OR p_tenant_id IS DISTINCT FROM auth_tenant_id()) THEN
    RAISE EXCEPTION 'NO_AUTORIZADO';
  END IF;

  SELECT page_access_token_encrypted INTO v_encrypted
    FROM ig_config
    WHERE tenant_id = p_tenant_id
      AND (p_ig_account_id IS NULL OR ig_account_id = p_ig_account_id)
    ORDER BY id DESC
    LIMIT 1;

  IF v_encrypted IS NULL THEN
    RAISE EXCEPTION 'IG_TOKEN_NOT_FOUND tenant % cuenta %', p_tenant_id, p_ig_account_id;
  END IF;

  v_token := pgp_sym_decrypt(v_encrypted, _get_ig_passphrase());
  RETURN v_token;
END;
$fn$;

GRANT EXECUTE ON FUNCTION get_ig_token(uuid, text) TO authenticated, service_role;
