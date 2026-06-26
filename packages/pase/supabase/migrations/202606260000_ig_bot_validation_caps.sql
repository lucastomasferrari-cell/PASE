-- ═══════════════════════════════════════════════════════════════════════════
-- Instagram bot — validations server-side + cap USD diario por tenant
-- 26-jun-2026 · Fix CRIT-4 del audit F6A (06a-instagram-bot.md)
--
-- Antes: un UPDATE a ig_config con `max_tokens=200000` o `system_prompt` de
-- 1MB no tenía topes en DB. Ahora:
--   - CHECK constraints en ig_config (max_tokens 128-4096, contexto 1-100,
--     system_prompt length < 50000 chars).
--   - Nueva columna `cap_diario_usd NUMERIC(8,2)` con default $5 USD/día.
--     El webhook compara contra SUM(llm_cost_usd) del día y pausa el bot
--     si excede.
--
-- Idempotente (DROP CONSTRAINT IF EXISTS / IF NOT EXISTS para column).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Cap diario USD por tenant (default $5/día — razonable para evitar runaway
-- sin estrangular bots legítimos; el dueño puede subirlo desde la UI hasta
-- $100/día sin riesgo de cost-runaway).
ALTER TABLE ig_config
  ADD COLUMN IF NOT EXISTS cap_diario_usd NUMERIC(8,2) NOT NULL DEFAULT 5.00;

-- Sanitizar valores corruptos previos (por si quedó algún max_tokens fuera de
-- rango por debug histórico). Los ponemos al default seguro antes de aplicar
-- el CHECK que sino fallaría.
UPDATE ig_config SET max_tokens = 1024
  WHERE max_tokens IS NULL OR max_tokens < 128 OR max_tokens > 4096;
UPDATE ig_config SET contexto_mensajes = 30
  WHERE contexto_mensajes IS NULL OR contexto_mensajes < 1 OR contexto_mensajes > 100;
UPDATE ig_config SET system_prompt = LEFT(system_prompt, 50000)
  WHERE system_prompt IS NOT NULL AND length(system_prompt) > 50000;
UPDATE ig_config SET cap_diario_usd = 5.00
  WHERE cap_diario_usd < 0.10 OR cap_diario_usd > 1000;

-- CHECK constraints
ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_max_tokens_sane;
ALTER TABLE ig_config ADD CONSTRAINT ig_config_max_tokens_sane
  CHECK (max_tokens BETWEEN 128 AND 4096);

ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_contexto_sane;
ALTER TABLE ig_config ADD CONSTRAINT ig_config_contexto_sane
  CHECK (contexto_mensajes BETWEEN 1 AND 100);

ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_prompt_sane;
ALTER TABLE ig_config ADD CONSTRAINT ig_config_prompt_sane
  CHECK (system_prompt IS NULL OR length(system_prompt) < 50000);

ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_cap_diario_sane;
ALTER TABLE ig_config ADD CONSTRAINT ig_config_cap_diario_sane
  CHECK (cap_diario_usd BETWEEN 0.10 AND 1000);

-- Verificación
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'ig_config' AND column_name = 'cap_diario_usd') = 1,
         'ig_config.cap_diario_usd no creada';
  ASSERT (SELECT COUNT(*) FROM pg_constraint
          WHERE conname IN ('ig_config_max_tokens_sane', 'ig_config_contexto_sane',
                            'ig_config_prompt_sane', 'ig_config_cap_diario_sane')) = 4,
         'faltan CHECK constraints en ig_config';
  RAISE NOTICE '✓ ig_config con CHECK constraints + cap_diario_usd $%/día default', 5.00;
END $$;

COMMIT;
