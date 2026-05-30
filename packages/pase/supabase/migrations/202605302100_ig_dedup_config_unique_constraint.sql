-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta — Dedup ig_config + crear UNIQUE (tenant_id, ig_account_id)
-- ─────────────────────────────────────────────────────────────────────────
--
-- BUG REAL (30-may, diagnosticado contra prod DB):
-- La migration 202605300000 (fase 1) decía agregar UNIQUE (tenant_id,
-- ig_account_id) pero NUNCA se aplicó en prod — el único constraint de
-- ig_config era el PRIMARY KEY (id). Consecuencia:
--
--   1. set_ig_token usa ON CONFLICT (tenant_id, ig_account_id). Sin el
--      constraint, cada conexión OAuth de @maneki insertó una fila NUEVA
--      en vez de actualizar la existente → 27 filas duplicadas (ids 4-30),
--      todas con el mismo ig_account_id.
--   2. El webhook hacía .eq('ig_account_id', X).single(). Con 27 filas,
--      .single() tira error (espera 1) → el bot NUNCA procesaba mensajes
--      de @maneki. Por eso "Maneki no responde".
--
-- Este script:
--   a. Borra duplicados conservando la fila de MAYOR id (token más reciente)
--      por cada (tenant_id, ig_account_id). Idempotente.
--   b. Crea el UNIQUE constraint que faltaba (si no existe ya).
--
-- Ya ejecutado en caliente vía script (26 filas borradas, constraint creado).
-- Esta migration deja la operación trackeada + re-aplicable.
--
-- Seguro: las filas duplicadas eran idénticas (mismo token, mismo account)
-- y NINGUNA estaba referenciada por conversaciones (todas las convs apuntan
-- a la cuenta original neko id=1).
-- ─────────────────────────────────────────────────────────────────────────

-- a. Dedup: borrar filas con id menor cuando hay otra con mismo
--    (tenant_id, ig_account_id) de id mayor.
DELETE FROM ig_config a
USING ig_config b
WHERE a.tenant_id = b.tenant_id
  AND a.ig_account_id = b.ig_account_id
  AND a.id < b.id;

-- b. Crear el UNIQUE constraint (idempotente — solo si no existe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ig_config'::regclass
      AND contype = 'u'
      AND conname = 'ig_config_tenant_account_uniq'
  ) THEN
    ALTER TABLE ig_config
      ADD CONSTRAINT ig_config_tenant_account_uniq UNIQUE (tenant_id, ig_account_id);
  END IF;
END $$;
