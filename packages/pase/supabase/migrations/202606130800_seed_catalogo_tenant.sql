-- ═══════════════════════════════════════════════════════════════════════════
-- Seed de catálogo GENÉRICO AR para tenant nuevo + wire en crear_tenant_v2 +
-- backfill de tenants existentes vacíos.
--
-- Tier 3 (informe 05-permisos-ajustes §2.2 / "no hay defaults, hay datos de
-- Neko"). Hoy un tenant nuevo arranca con config_categorias / medios_cobro /
-- rrhh_puestos en CERO y los hooks useCategorias / useMediosCobro caen al
-- fallback hardcodeado de constants.ts (= categorías REALES de Neko: EDESUR,
-- SUSHIMAN PM, WOKI…). El cliente nuevo ve en sus dropdowns categorías ajenas
-- que no existen en su DB → "día 1 roto/confuso".
--
-- Fix de DB (esta migración): sembrar un catálogo default genérico, liviano y
-- editable al crear el tenant + backfillear los tenants vacíos existentes.
-- Neko se saltea en el backfill (ya tiene su catálogo real → guard por
-- gasto_fijo). La función es idempotente por (tenant_id, nombre[, tipo]) así
-- que re-correrla nunca duplica.
--
-- Reglas: C7 (multi-tenant — tenant_id explícito), C11 (SECURITY DEFINER con
-- GRANT solo a service_role + authenticated; el dedup la hace segura para
-- authenticated), REVOKE FROM PUBLIC, anon.
--
-- Esquemas verificados (recon 13-jun):
--   config_categorias(tipo, nombre, activo, orden, grupo, tenant_id NOT NULL)
--     tipos:  gasto_fijo | gasto_variable | gasto_publicidad | gasto_comision
--             | gasto_impuesto | retiro_socio | gasto_juicios_demandas
--             | cat_compra | cat_ingreso
--     grupos: Gastos Fijos | Gastos Variables | Publicidad y MKT | Comisiones
--             | Impuestos | Retiros Socios | Juicios y Demandas | CMV | INGRESOS
--     (sin UNIQUE → dedup con NOT EXISTS por (tenant_id, nombre, tipo))
--   medios_cobro(tenant_id NOT NULL, local_id, nombre, slug NOT NULL, emoji,
--                pide_vuelto NOT NULL DEFAULT false, cuenta_destino, activo,
--                orden, deleted_at)  — slug = slugify(nombre); globales del
--                tenant = local_id NULL.
--   rrhh_puestos(nombre NOT NULL, activo, orden, tenant_id NOT NULL,
--                UNIQUE(tenant_id, nombre)).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- fn_seed_catalogo_tenant: siembra el catálogo genérico AR para un tenant.
-- Idempotente: NOT EXISTS / NOT EXISTS-equivalente en los 3 bloques.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_seed_catalogo_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_ID_REQUERIDO';
  END IF;

  -- ── 1) Categorías (config_categorias) ────────────────────────────────────
  -- tipo + grupo + nombre + orden. Dedup por (tenant_id, nombre, tipo).
  INSERT INTO config_categorias (tenant_id, tipo, grupo, nombre, orden, activo)
  SELECT p_tenant_id, v.tipo, v.grupo, v.nombre, v.orden, true
  FROM (VALUES
    -- Gastos Fijos
    ('gasto_fijo',            'Gastos Fijos',     'Alquiler',                       1),
    ('gasto_fijo',            'Gastos Fijos',     'Luz',                            2),
    ('gasto_fijo',            'Gastos Fijos',     'Gas',                            3),
    ('gasto_fijo',            'Gastos Fijos',     'Agua',                           4),
    ('gasto_fijo',            'Gastos Fijos',     'Internet',                       5),
    ('gasto_fijo',            'Gastos Fijos',     'Seguro',                         6),
    ('gasto_fijo',            'Gastos Fijos',     'Mantenimiento',                  7),
    ('gasto_fijo',            'Gastos Fijos',     'Otros fijos',                    8),
    -- Gastos Variables
    ('gasto_variable',        'Gastos Variables', 'Compras generales',             1),
    ('gasto_variable',        'Gastos Variables', 'Limpieza',                       2),
    ('gasto_variable',        'Gastos Variables', 'Librería/insumos',              3),
    ('gasto_variable',        'Gastos Variables', 'Envíos',                         4),
    ('gasto_variable',        'Gastos Variables', 'Reparaciones',                   5),
    ('gasto_variable',        'Gastos Variables', 'Otros variables',                6),
    -- Publicidad y MKT
    ('gasto_publicidad',      'Publicidad y MKT', 'Redes/Community',                1),
    ('gasto_publicidad',      'Publicidad y MKT', 'Pauta digital',                  2),
    ('gasto_publicidad',      'Publicidad y MKT', 'Otras publicidades',             3),
    -- Comisiones
    ('gasto_comision',        'Comisiones',       'Comisión MercadoPago',           1),
    ('gasto_comision',        'Comisiones',       'Comisión plataformas delivery',  2),
    ('gasto_comision',        'Comisiones',       'Comisiones bancarias',           3),
    ('gasto_comision',        'Comisiones',       'Otras comisiones',               4),
    -- Impuestos
    ('gasto_impuesto',        'Impuestos',        'IVA',                            1),
    ('gasto_impuesto',        'Impuestos',        'Ingresos Brutos',                2),
    ('gasto_impuesto',        'Impuestos',        'Retenciones',                    3),
    ('gasto_impuesto',        'Impuestos',        'Otros impuestos',                4),
    -- Retiros socios
    ('retiro_socio',          'Retiros Socios',   'Retiro socio',                   1),
    -- Juicios y demandas
    ('gasto_juicios_demandas','Juicios y Demandas','Juicios y demandas',            1),
    ('gasto_juicios_demandas','Juicios y Demandas','Honorarios legales',            2),
    -- Compras / CMV
    ('cat_compra',            'CMV',              'Alimentos frescos',              1),
    ('cat_compra',            'CMV',              'Bebidas',                        2),
    ('cat_compra',            'CMV',              'Vinos',                          3),
    ('cat_compra',            'CMV',              'Almacén',                        4),
    ('cat_compra',            'CMV',              'Packaging',                      5),
    ('cat_compra',            'CMV',              'Limpieza e higiene',             6),
    ('cat_compra',            'CMV',              'Papelería',                      7),
    ('cat_compra',            'CMV',              'Equipamiento',                   8),
    ('cat_compra',            'CMV',              'Otros',                          9),
    -- Ingresos
    ('cat_ingreso',           'INGRESOS',         'Liquidación delivery',           1),
    ('cat_ingreso',           'INGRESOS',         'Liquidación MercadoPago',        2),
    ('cat_ingreso',           'INGRESOS',         'Ingreso por evento',             3),
    ('cat_ingreso',           'INGRESOS',         'Ingreso socio',                  4),
    ('cat_ingreso',           'INGRESOS',         'Devolución proveedor',           5),
    ('cat_ingreso',           'INGRESOS',         'Otro ingreso',                   6)
  ) AS v(tipo, grupo, nombre, orden)
  WHERE NOT EXISTS (
    SELECT 1 FROM config_categorias cc
    WHERE cc.tenant_id = p_tenant_id
      AND cc.nombre = v.nombre
      AND cc.tipo = v.tipo
  );

  -- ── 2) Medios de cobro (medios_cobro) ─────────────────────────────────────
  -- slug = slugify(nombre) (lower, sin acentos, [^a-z0-9]+ → '_', trim '_').
  -- cuenta_destino 'Caja Chica' solo para los efectivos; el resto NULL.
  -- Globales del tenant (local_id NULL). Dedup por (tenant_id, nombre) global.
  INSERT INTO medios_cobro (tenant_id, local_id, nombre, slug, emoji, pide_vuelto, cuenta_destino, activo, orden)
  SELECT
    p_tenant_id,
    NULL,
    v.nombre,
    btrim(regexp_replace(lower(translate(v.nombre,
      'ÁÉÍÓÚÜáéíóúüÑñ', 'AEIOUUaeiouuNn')), '[^a-z0-9]+', '_', 'g'), '_'),
    v.emoji,
    v.pide_vuelto,
    v.cuenta_destino,
    true,
    v.orden
  FROM (VALUES
    ('Efectivo',          '💵', true,  'Caja Chica'::text,  1),
    ('Efectivo delivery', '💵', true,  'Caja Chica'::text,  2),
    ('Tarjeta débito',    '💳', false, NULL::text,          3),
    ('Tarjeta crédito',   '💳', false, NULL::text,          4),
    ('QR / billetera',    '📱', false, NULL::text,          5),
    ('Transferencia',     '🏦', false, NULL::text,          6),
    ('MercadoPago',       '📱', false, NULL::text,          7),
    ('Link de pago',      '🔗', false, NULL::text,          8),
    ('Delivery apps',     '🛵', false, NULL::text,          9),
    ('Otros',             '•',  false, NULL::text,         10)
  ) AS v(nombre, emoji, pide_vuelto, cuenta_destino, orden)
  WHERE NOT EXISTS (
    SELECT 1 FROM medios_cobro mc
    WHERE mc.tenant_id = p_tenant_id
      AND mc.local_id IS NULL
      AND upper(mc.nombre) = upper(v.nombre)
      AND mc.deleted_at IS NULL
  );

  -- ── 3) Puestos RRHH (rrhh_puestos) ────────────────────────────────────────
  -- UNIQUE(tenant_id, nombre) → ON CONFLICT DO NOTHING (idempotente).
  INSERT INTO rrhh_puestos (tenant_id, nombre, orden, activo)
  SELECT p_tenant_id, v.nombre, v.orden, true
  FROM (VALUES
    ('Dueño',             1),
    ('Encargado',         2),
    ('Cocinero',          3),
    ('Mozo',              4),
    ('Cajero',            5),
    ('Bachero/Limpieza',  6),
    ('Barman',            7),
    ('Cadete/Delivery',   8)
  ) AS v(nombre, orden)
  ON CONFLICT (tenant_id, nombre) DO NOTHING;
END;
$$;

-- C11: SECURITY DEFINER → escalar privilegios solo a quien debe.
-- crear_tenant_v2 (service_role) la invoca; authenticated puede llamarla desde
-- un endpoint con sesión dueño (el dedup la hace segura — nunca duplica).
REVOKE ALL ON FUNCTION fn_seed_catalogo_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_seed_catalogo_tenant(uuid) TO service_role, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- crear_tenant_v2 v2: copia EXACTA de la vigente (202605102318) + un solo
-- PERFORM fn_seed_catalogo_tenant(v_tenant_id) justo antes del RETURN.
-- Firma / SECURITY DEFINER / search_path / auth / GRANT idénticos.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crear_tenant_v2(
  p_nombre text,
  p_slug text,
  p_plan text,
  p_dueno_email text,
  p_dueno_nombre text,
  p_auth_id uuid,          -- UID de auth.users (creado por el endpoint serverless ANTES de llamar a este RPC)
  p_local_nombre text,
  p_local_direccion text DEFAULT NULL,
  p_trial_dias int DEFAULT 14
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_usuario_id integer;
  v_local_id integer;
  v_trial_ends timestamptz;
BEGIN
  -- 1. Validaciones de input.
  IF p_auth_id IS NULL THEN RAISE EXCEPTION 'AUTH_ID_REQUIRED'; END IF;
  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN RAISE EXCEPTION 'NOMBRE_REQUIRED'; END IF;
  IF p_slug IS NULL OR trim(p_slug) = '' THEN RAISE EXCEPTION 'SLUG_REQUIRED'; END IF;
  IF p_dueno_email IS NULL OR trim(p_dueno_email) = '' THEN RAISE EXCEPTION 'DUENO_EMAIL_REQUIRED'; END IF;
  IF p_local_nombre IS NULL OR trim(p_local_nombre) = '' THEN RAISE EXCEPTION 'LOCAL_NOMBRE_REQUIRED'; END IF;

  -- 2. Slug único.
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'SLUG_DUPLICATED';
  END IF;

  -- 3. Email único en usuarios.
  IF EXISTS (SELECT 1 FROM usuarios WHERE email = p_dueno_email) THEN
    RAISE EXCEPTION 'EMAIL_DUPLICATED';
  END IF;

  -- 4. auth_id único (defense-in-depth: nadie debería poder reusar un UID).
  IF EXISTS (SELECT 1 FROM usuarios WHERE auth_id = p_auth_id) THEN
    RAISE EXCEPTION 'AUTH_ID_DUPLICATED';
  END IF;

  -- 5. trial_ends_at si plan='trial'.
  v_trial_ends := CASE
    WHEN p_plan = 'trial' THEN now() + (p_trial_dias || ' days')::interval
    ELSE NULL
  END;

  -- 6. Crear tenant.
  INSERT INTO tenants (nombre, slug, plan, trial_ends_at, activo)
  VALUES (p_nombre, p_slug, COALESCE(p_plan, 'trial'), v_trial_ends, true)
  RETURNING id INTO v_tenant_id;

  -- 7. Crear usuario dueño linkeado a auth_id.
  --    password = '__supabase_auth_only__' es un placeholder legacy. La
  --    columna usuarios.password queda como NOT NULL (no se puede dropear
  --    sin migration aparte), pero el sistema activo es Supabase Auth.
  --    password_temporal=true para que el dueño cambie su password al primer
  --    login (UX). Si no quiere cambiarlo, igual funciona — el flag es
  --    UX, no security.
  INSERT INTO usuarios (
    nombre, email, password, rol, tenant_id, activo, password_temporal, auth_id
  )
  VALUES (
    p_dueno_nombre, p_dueno_email, '__supabase_auth_only__',
    'dueno', v_tenant_id, true, true, p_auth_id
  )
  RETURNING id INTO v_usuario_id;

  -- 8. Crear primer local del tenant.
  INSERT INTO locales (nombre, tenant_id)
  VALUES (p_local_nombre, v_tenant_id)
  RETURNING id INTO v_local_id;

  -- 9. Vincular dueño en tenant_admins.
  INSERT INTO tenant_admins (tenant_id, usuario_id, rol)
  VALUES (v_tenant_id, v_usuario_id, 'dueno');

  -- 10. Auditar.
  INSERT INTO auditoria (tabla, accion, detalle, tenant_id)
  VALUES ('tenants', 'CREAR_V2', jsonb_build_object(
    'tenant_id', v_tenant_id,
    'slug', p_slug,
    'dueno_id', v_usuario_id,
    'dueno_auth_id', p_auth_id,
    'local_id', v_local_id
  )::text, v_tenant_id);

  -- 11. Sembrar el catálogo genérico AR (categorías, medios, puestos) para que
  --     el tenant arranque con dropdowns poblados — no con el fallback de Neko.
  PERFORM fn_seed_catalogo_tenant(v_tenant_id);

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', v_tenant_id,
    'usuario_id', v_usuario_id,
    'local_id', v_local_id,
    'slug', p_slug,
    'plan', p_plan,
    'trial_ends_at', v_trial_ends
  );
END;
$$;

-- Solo el service_role puede invocar v2 (idéntico a la vigente).
REVOKE ALL ON FUNCTION crear_tenant_v2(text, text, text, text, text, uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION crear_tenant_v2(text, text, text, text, text, uuid, text, text, int) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Backfill: sembrar el catálogo a cada tenant activo que NO tenga ninguna
-- categoría de gasto_fijo (= tenant genuinamente vacío). Neko ya tiene las
-- suyas → se saltea. La idempotencia por nombre/tipo lo hace seguro igual.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE activo LOOP
    IF NOT EXISTS (
      SELECT 1 FROM config_categorias
      WHERE tenant_id = t.id AND tipo = 'gasto_fijo'
    ) THEN
      PERFORM fn_seed_catalogo_tenant(t.id);
    END IF;
  END LOOP;
END $$;

COMMIT;
