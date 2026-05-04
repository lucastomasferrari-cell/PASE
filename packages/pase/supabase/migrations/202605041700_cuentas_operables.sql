-- ═══════════════════════════════════════════════════════════════════════════
-- TASK refactor-permisos-cuentas: separar permisos de cuenta en dos listas.
--
-- ANTES (un solo flag):
--   usuarios.cuentas_visibles TEXT[]:
--     - NULL  → ve todas las cuentas (saldos + operar)
--     - []    → no ve ninguna
--     - [...] → solo esas cuentas (saldos + operar)
--
-- DESPUÉS (dos flags semánticamente distintos):
--   usuarios.cuentas_visibles TEXT[]:
--     - controla qué cuentas el usuario PUEDE VER EL SALDO de (cards de
--       Tesorería, totales del Cashflow). NULL = todas.
--   usuarios.cuentas_operables TEXT[] (NUEVO):
--     - controla qué cuentas el usuario PUEDE OPERAR contra (cargar gastos,
--       pagos, ingresos, egresos). NULL = todas.
--
-- En las listas de movimientos, el usuario ve los movimientos de
-- (cuentas_visibles ∪ cuentas_operables) — ver al usuario operar contra
-- una cuenta sin saldo es coherente con "puede pagar pero no ve cuánto hay".
--
-- Migración inicial (decisión B1 de Lucas): cuentas_operables arranca
-- COPIANDO cuentas_visibles. El dueño después ajusta caso por caso vía
-- editor de Usuarios. Eso preserva el comportamiento previo a esta migration
-- — nadie obtiene ni pierde permisos automáticamente.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columna nueva.
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS cuentas_operables TEXT[] NULL;

COMMENT ON COLUMN usuarios.cuentas_operables IS
  'Cuentas contra las que el usuario puede cargar movimientos/pagos. '
  'NULL = sin restricción (admin/dueño). '
  'Se evalúa SOLO en frontend hoy; las RPCs no validan cuenta.';

-- 2. Backfill: copiar cuentas_visibles → cuentas_operables (donde no se
--    haya seteado todavía). El COALESCE preserva NULL si visibles es NULL
--    (admin/dueño).
UPDATE usuarios
   SET cuentas_operables = cuentas_visibles
 WHERE cuentas_operables IS NULL
   AND cuentas_visibles IS NOT NULL;

-- 3. Funciones SQL helper para uso futuro desde RPCs / RLS policies. Hoy
--    NO hay policies que filtren por cuenta en este repo (auth.ts evalúa
--    cuentas_visibles solo en frontend). Estas funciones quedan listas
--    para cuando se quiera agregar defense-in-depth en DB.
--
--    Convención de auth_usuario_id() ya existe en migrations previas
--    (202604281206_rpcs_hardening_tenant.sql). La reusamos.

-- Cuentas que el usuario actual puede VER EL SALDO de.
CREATE OR REPLACE FUNCTION auth_cuentas_visibles()
RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cuentas_visibles
    FROM usuarios
   WHERE id = auth_usuario_id();
$$;

-- Cuentas contra las que el usuario actual puede OPERAR.
CREATE OR REPLACE FUNCTION auth_cuentas_operables()
RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cuentas_operables
    FROM usuarios
   WHERE id = auth_usuario_id();
$$;

-- Unión de visibles + operables. Devuelve NULL ("todas") si CUALQUIERA
-- de las dos es NULL — un user que ve todos los saldos pero solo opera
-- algunas cuentas igual ve TODOS los movimientos. Esto define el alcance
-- de las listas de movimientos en Tesorería/Cashflow.
CREATE OR REPLACE FUNCTION auth_cuentas_visibles_para_listados()
RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    CASE
      WHEN u.cuentas_visibles IS NULL OR u.cuentas_operables IS NULL THEN NULL
      ELSE ARRAY(
        SELECT DISTINCT unnest(
          COALESCE(u.cuentas_visibles, ARRAY[]::TEXT[])
            || COALESCE(u.cuentas_operables, ARRAY[]::TEXT[])
        )
      )
    END
    FROM usuarios u
   WHERE u.id = auth_usuario_id();
$$;

-- Permisos de las helpers: authenticated puede leer (las usa el frontend
-- vía RPC eventualmente, o las RLS policies en el futuro).
GRANT EXECUTE ON FUNCTION auth_cuentas_visibles()                     TO authenticated;
GRANT EXECUTE ON FUNCTION auth_cuentas_operables()                    TO authenticated;
GRANT EXECUTE ON FUNCTION auth_cuentas_visibles_para_listados()       TO authenticated;
