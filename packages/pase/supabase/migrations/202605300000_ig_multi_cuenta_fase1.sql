-- ─────────────────────────────────────────────────────────────────────────
-- IG multi-cuenta Fase 1 — modelo de datos
-- ─────────────────────────────────────────────────────────────────────────
--
-- Lucas 29-may noche: el sistema asume 1 cuenta IG por tenant pero los
-- clientes reales (Neko, futuros clientes) tienen N cuentas distintas
-- (@nekosushi.ar, @rene, @maneki, etc.). Hoy ig_config tiene PK=(tenant_id)
-- → solo 1 fila por cliente.
--
-- Esta migration NO rompe nada — backward compatible:
--   - La fila existente recibe id=1 + local_id=NULL (NULL = cuenta global
--     del tenant, cubre todos los locales — comportamiento actual)
--   - Las conversaciones existentes apuntan a esa fila via nuevo
--     ig_config_id.
--
-- Fases siguientes (en próximos commits):
--   2) Webhook: rutear DM por recipient.id → ig_config correspondiente
--   3) OAuth callback: agregar cuenta sin pisar las existentes
--   4) UI Configurar bot: lista multi-cuenta + asignar local
--   5) UI Mensajería: filtrar por local activo
-- ─────────────────────────────────────────────────────────────────────────

-- ─── ig_config: cambiar PK de (tenant_id) a (id) ───────────────────────

-- 1. Agregar columna id (sin PK aún) con valores únicos
ALTER TABLE ig_config ADD COLUMN IF NOT EXISTS id BIGSERIAL;

-- 2. Drop el PK viejo
ALTER TABLE ig_config DROP CONSTRAINT IF EXISTS ig_config_pkey;

-- 3. Setear el nuevo PK en id
ALTER TABLE ig_config ADD CONSTRAINT ig_config_pkey PRIMARY KEY (id);

-- 4. UNIQUE (tenant_id, ig_account_id) → impide que el mismo tenant tenga
--    la misma cuenta IG conectada 2 veces (UPDATE en lugar de duplicar).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ig_config_tenant_account
  ON ig_config (tenant_id, ig_account_id);

-- 5. Mantener UNIQUE global de ig_account_id (Meta no permite que la misma
--    cuenta esté conectada en 2 tenants distintos — error de OAuth)
-- (Esto ya existe como ig_config_ig_account_id_key — no cambia)

-- 6. Agregar local_id NULL — NULL = global del tenant (= comportamiento actual)
ALTER TABLE ig_config ADD COLUMN IF NOT EXISTS local_id INTEGER
  REFERENCES locales(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ig_config_tenant_local
  ON ig_config (tenant_id, local_id);

COMMENT ON COLUMN ig_config.local_id IS
  'Local al que pertenece esta cuenta IG. NULL = cuenta global del tenant '
  '(cubre todos los locales). Permite tener 1 cuenta IG por marca/local.';

-- ─── ig_conversaciones: agregar ig_config_id ───────────────────────────

ALTER TABLE ig_conversaciones
  ADD COLUMN IF NOT EXISTS ig_config_id BIGINT REFERENCES ig_config(id) ON DELETE SET NULL;

-- Backfill: las conversaciones existentes apuntan a la ig_config del tenant.
-- Como hoy hay 1 sola por tenant, el matcheo es directo.
UPDATE ig_conversaciones cc
SET ig_config_id = cfg.id
FROM ig_config cfg
WHERE cc.ig_config_id IS NULL
  AND cc.tenant_id = cfg.tenant_id;

CREATE INDEX IF NOT EXISTS idx_ig_conversaciones_config
  ON ig_conversaciones (ig_config_id);

COMMENT ON COLUMN ig_conversaciones.ig_config_id IS
  'Cuenta IG a la que pertenece esta conversación. Para multi-cuenta '
  '(refactor 29-may): permite filtrar conversaciones por local via JOIN '
  'a ig_config.local_id.';

-- ─── Validación post-migration ──────────────────────────────────────────

DO $$
DECLARE
  v_configs_sin_id INT;
  v_convs_sin_config INT;
BEGIN
  SELECT count(*) INTO v_configs_sin_id FROM ig_config WHERE id IS NULL;
  IF v_configs_sin_id > 0 THEN
    RAISE EXCEPTION 'BACKFILL FAIL: % ig_config sin id', v_configs_sin_id;
  END IF;

  SELECT count(*) INTO v_convs_sin_config FROM ig_conversaciones
    WHERE ig_config_id IS NULL;
  IF v_convs_sin_config > 0 THEN
    RAISE WARNING 'WARN: % ig_conversaciones sin ig_config_id (huérfanas — capaz de tenants sin ig_config)', v_convs_sin_config;
  END IF;
END $$;
