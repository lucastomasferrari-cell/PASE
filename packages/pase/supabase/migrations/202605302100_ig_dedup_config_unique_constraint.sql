-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta — UNIQUE (tenant_id, ig_account_id) defensivo
-- ─────────────────────────────────────────────────────────────────────────
--
-- Contexto (30-may): al diagnosticar "el bot de Maneki no responde" contra
-- la prod DB encontré que ya existía el índice único uniq_ig_config_tenant_account
-- (creado por la fase 1), así que NO había filas duplicadas — solo 2 filas
-- (neko id=1, maneki id=2). Mi hipótesis inicial de "27 duplicados" fue
-- incorrecta; la dejo documentada para que no se repita el diagnóstico.
--
-- El bug REAL era otro (NO se arregla con esta migration, se arregló con un
-- UPDATE puntual del ig_account_id de Maneki — ver abajo):
--   El ig_account_id que guardamos al conectar Maneki por OAuth era el IGSID
--   del dueño (28556475980608004), pero Meta manda en los webhooks el
--   Page-scoped Business Account ID (17841467521836815). Como no coincidían,
--   el webhook tiraba "ig_account_id ... sin config" y nunca procesaba los
--   DMs de Maneki. Se corrigió el ig_account_id de esa fila al valor que usa
--   Meta en los webhooks.
--
-- Esta migration solo agrega un CONSTRAINT nombrado (además del índice único
-- que ya existe) por las dudas, de forma idempotente. No borra nada.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ig_config'::regclass
      AND contype = 'u'
      AND conname = 'ig_config_tenant_account_uniq'
  ) THEN
    -- Solo si no hay duplicados (no debería haberlos). Si los hubiera,
    -- esta sentencia falla y avisa en vez de borrar datos silenciosamente.
    ALTER TABLE ig_config
      ADD CONSTRAINT ig_config_tenant_account_uniq UNIQUE (tenant_id, ig_account_id);
  END IF;
END $$;
