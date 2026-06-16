# Módulo Utilidades / Reparto — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el módulo Utilidades de PASE: socios por local + %, una CAJA UTILIDADES de reserva, registrar repartos prolijos (split por % → gastos `retiro_socio` que hitean EERR + cashflow), y el calculador "cuánto es seguro repartir" (plata total − obligaciones pendientes − colchón dinámico).

**Architecture:** Backend en migraciones Supabase (tablas `utilidades_*` con RLS dual + RPCs atómicas SECURITY DEFINER). Reusa `transferencia_cuentas` (reservar) y `crear_gasto` (los retiros, tipo='retiro_socio'). El calculador reusa `cashflow_resumen_mes`. Frontend: servicio `src/lib/utilidades.ts` + pantalla `src/pages/Utilidades.tsx` (lazy) en sección Dirección.

**Tech Stack:** React 19 + Vite + TypeScript estricto, Supabase (Postgres + RLS), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-06-16-utilidades-reparto-design.md` (leer antes de empezar).

**Reglas del repo (obligatorias):** RPCs atómicas, `applyLocalScope` en queries con `local_id`, RLS dual, lazy import en `App.tsx` (C8), idempotency en RPCs que mueven plata (C1), error codes UPPER_SNAKE (C9), auth check + `REVOKE FROM PUBLIC,anon` en SECURITY DEFINER (C11), test E2E mutante (C2) + tocar e2e-full.

---

## FASE 1 — Esquema de datos

### Task 1: Migración con las 3 tablas `utilidades_*` + RLS

**Files:**
- Create: `packages/pase/supabase/migrations/202606160100_utilidades_schema.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 202606160100_utilidades_schema.sql
-- Módulo Utilidades: socios por local + %, repartos y su detalle por socio.
-- CAJA UTILIDADES NO es tabla nueva: es una cuenta en saldos_caja/movimientos
-- (el cashflow ya la reconoce). Se crea on-demand al primer reservar.
BEGIN;

CREATE TABLE IF NOT EXISTS utilidades_socios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  local_id    INTEGER NOT NULL,
  nombre      TEXT NOT NULL,
  porcentaje  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (porcentaje >= 0 AND porcentaje <= 100),
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_util_socios_tl ON utilidades_socios(tenant_id, local_id);

CREATE TABLE IF NOT EXISTS utilidades_repartos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  fecha         DATE NOT NULL,
  periodo_ref   DATE,                          -- mes de ganancia al que corresponde (opcional)
  total         NUMERIC(14,2) NOT NULL DEFAULT 0,
  cuenta_origen TEXT NOT NULL DEFAULT 'CAJA UTILIDADES',
  nota          TEXT,
  anulado       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_util_repartos_tl ON utilidades_repartos(tenant_id, local_id, fecha);

CREATE TABLE IF NOT EXISTS utilidades_reparto_detalle (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  reparto_id  UUID NOT NULL REFERENCES utilidades_repartos(id) ON DELETE CASCADE,
  socio_id    UUID NOT NULL REFERENCES utilidades_socios(id),
  monto       NUMERIC(14,2) NOT NULL DEFAULT 0,
  gasto_id    TEXT,                            -- el gasto retiro_socio generado (para reversar)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_util_detalle_reparto ON utilidades_reparto_detalle(reparto_id);

-- RLS dual con local_id
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['utilidades_socios','utilidades_repartos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_all ON %I', t, t);
    EXECUTE format($p$CREATE POLICY %I_all ON %I FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
      WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))$p$, t, t);
  END LOOP;
END $$;

-- detalle: RLS por tenant + vía el reparto padre (hija)
ALTER TABLE utilidades_reparto_detalle ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utilidades_reparto_detalle_all ON utilidades_reparto_detalle;
CREATE POLICY utilidades_reparto_detalle_all ON utilidades_reparto_detalle FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND EXISTS (
    SELECT 1 FROM utilidades_repartos r WHERE r.id = reparto_id
      AND (auth_es_dueno_o_admin() OR r.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (tenant_id = auth_tenant_id());

COMMIT;
```

- [ ] **Step 2: Aplicar** (flujo oficial `vercel env pull` → script `pg`) + **Step 3: Verificar** `SELECT to_regclass('public.utilidades_socios')` etc. no-null para las 3; las 3 con RLS habilitado (linter). **Step 4: Commit** — `feat(utilidades): schema (socios, repartos, detalle) + RLS`

---

## FASE 2 — RPCs de gestión

### Task 2: RPC `utilidades_guardar_socio`

**Files:**
- Create: `packages/pase/supabase/migrations/202606160200_utilidades_socios_rpc.sql`

- [ ] **Step 1: Escribir la RPC**

```sql
-- 202606160200_utilidades_socios_rpc.sql
BEGIN;
-- Upsert de un socio. Devuelve la suma de % activos del local (la UI avisa si != 100).
CREATE OR REPLACE FUNCTION utilidades_guardar_socio(
  p_local_id integer, p_id uuid, p_nombre text, p_porcentaje numeric, p_activo boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_tenant uuid; v_id uuid; v_suma numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF COALESCE(TRIM(p_nombre),'') = '' THEN RAISE EXCEPTION 'NOMBRE_REQUERIDO'; END IF;
  IF p_porcentaje < 0 OR p_porcentaje > 100 THEN RAISE EXCEPTION 'PORCENTAJE_INVALIDO'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO utilidades_socios (tenant_id, local_id, nombre, porcentaje, activo)
    VALUES (v_tenant, p_local_id, TRIM(p_nombre), p_porcentaje, p_activo) RETURNING id INTO v_id;
  ELSE
    UPDATE utilidades_socios SET nombre=TRIM(p_nombre), porcentaje=p_porcentaje, activo=p_activo, updated_at=NOW()
    WHERE id=p_id AND tenant_id=v_tenant AND local_id=p_local_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'SOCIO_NO_ENCONTRADO'; END IF;
  END IF;

  SELECT COALESCE(SUM(porcentaje),0) INTO v_suma FROM utilidades_socios
    WHERE tenant_id=v_tenant AND local_id=p_local_id AND activo;
  RETURN jsonb_build_object('id', v_id, 'suma_porcentajes', v_suma);
END $$;
REVOKE ALL ON FUNCTION utilidades_guardar_socio(integer,uuid,text,numeric,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_guardar_socio(integer,uuid,text,numeric,boolean) TO authenticated;
COMMIT;
```

- [ ] **Step 2:** Aplicar + verificar (existe, DEFINER, grants). **Step 3: Commit** — `feat(utilidades): RPC guardar socio`

### Task 3: RPC `utilidades_reservar` (apartar a CAJA UTILIDADES)

**Files:**
- Create: `packages/pase/supabase/migrations/202606160300_utilidades_reservar.sql`

- [ ] **Step 1: Escribir la RPC** — asegura que la cuenta CAJA UTILIDADES exista en `saldos_caja` (la crea con saldo 0 si falta; el trigger de saldos la mantiene) y reusa `transferencia_cuentas`.

```sql
-- 202606160300_utilidades_reservar.sql
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_reservar(
  p_local_id integer, p_cuenta_origen text, p_monto numeric, p_fecha date, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_tenant uuid; v_cached jsonb;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='utilidades_reservar' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  -- Asegurar la cuenta CAJA UTILIDADES (insert si no existe; el trigger de saldos
  -- la deriva del ledger, así que un insert con saldo 0 alcanza como ancla).
  INSERT INTO saldos_caja (tenant_id, local_id, cuenta, saldo)
  VALUES (v_tenant, p_local_id, 'CAJA UTILIDADES', 0)
  ON CONFLICT (tenant_id, local_id, cuenta) DO NOTHING;

  -- Transferencia interna operativo → CAJA UTILIDADES (el cashflow la netea).
  PERFORM transferencia_cuentas(p_local_id, p_cuenta_origen, 'CAJA UTILIDADES', p_monto, p_fecha, 'Reserva de utilidades');

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('utilidades_reservar',p_idempotency_key,v_tenant,jsonb_build_object('reservado',p_monto))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('reservado', p_monto);
END $$;
REVOKE ALL ON FUNCTION utilidades_reservar(integer,text,numeric,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_reservar(integer,text,numeric,date,text) TO authenticated;
COMMIT;
```

- [ ] **Step 2:** Aplicar + verificar. **OJO durante ejecución:** confirmar el nombre real de la PK/unique de `saldos_caja` para el `ON CONFLICT` (puede ser `(tenant_id, local_id, cuenta)` u otra) — ajustar el target del ON CONFLICT a la constraint real. Verificar también que `transferencia_cuentas` no exija que la cuenta destino pre-exista con saldo (si lo hace, el insert previo lo cubre).
- [ ] **Step 3: Commit** — `feat(utilidades): RPC reservar (apartar a CAJA UTILIDADES)`

### Task 4: RPC `utilidades_registrar_reparto` + `utilidades_anular_reparto`

**Files:**
- Create: `packages/pase/supabase/migrations/202606160400_utilidades_reparto.sql`

- [ ] **Step 1: Escribir las RPCs.** `registrar_reparto` crea un gasto `retiro_socio` por socio (reusa `crear_gasto`, que hitea EERR + cashflow) y guarda el reparto + detalle. `anular_reparto` anula esos gastos (reusa `anular_gasto`) + marca el reparto.

```sql
-- 202606160400_utilidades_reparto.sql
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_registrar_reparto(
  p_local_id integer, p_fecha date, p_total numeric, p_cuenta_origen text,
  p_periodo_ref date, p_nota text, p_detalle jsonb, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_cached jsonb; v_reparto_id uuid; v_ln jsonb; v_suma numeric := 0;
  v_socio record; v_gasto_id text;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='utilidades_registrar_reparto' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  -- Validar que el detalle sume el total.
  SELECT COALESCE(SUM((e->>'monto')::numeric),0) INTO v_suma FROM jsonb_array_elements(p_detalle) e;
  IF ABS(v_suma - p_total) > 0.01 THEN RAISE EXCEPTION 'DETALLE_NO_SUMA_TOTAL'; END IF;

  INSERT INTO utilidades_repartos (tenant_id, local_id, fecha, periodo_ref, total, cuenta_origen, nota)
  VALUES (v_tenant, p_local_id, p_fecha, p_periodo_ref, p_total, COALESCE(p_cuenta_origen,'CAJA UTILIDADES'), p_nota)
  RETURNING id INTO v_reparto_id;

  FOR v_ln IN SELECT * FROM jsonb_array_elements(p_detalle) LOOP
    SELECT id, nombre INTO v_socio FROM utilidades_socios
      WHERE id=(v_ln->>'socio_id')::uuid AND tenant_id=v_tenant AND local_id=p_local_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOCIO_NO_ENCONTRADO'; END IF;
    -- Crea el gasto retiro_socio (genera el movimiento; hitea EERR + cashflow).
    v_gasto_id := crear_gasto(p_fecha, p_local_id, 'RETIROS DE SOCIOS', 'retiro_socio',
                              (v_ln->>'monto')::numeric, 'Reparto utilidades — ' || v_socio.nombre,
                              COALESCE(p_cuenta_origen,'CAJA UTILIDADES'), NULL);
    INSERT INTO utilidades_reparto_detalle (tenant_id, reparto_id, socio_id, monto, gasto_id)
    VALUES (v_tenant, v_reparto_id, v_socio.id, (v_ln->>'monto')::numeric, v_gasto_id);
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('utilidades_registrar_reparto',p_idempotency_key,v_tenant,jsonb_build_object('reparto_id',v_reparto_id))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('reparto_id', v_reparto_id, 'total', p_total);
END $$;
REVOKE ALL ON FUNCTION utilidades_registrar_reparto(integer,date,numeric,text,date,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_registrar_reparto(integer,date,numeric,text,date,text,jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION utilidades_anular_reparto(p_reparto_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v_tenant uuid; v_local integer; v_det record; v_n int := 0;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  SELECT local_id INTO v_local FROM utilidades_repartos WHERE id=p_reparto_id AND tenant_id=v_tenant AND NOT anulado;
  IF v_local IS NULL THEN RAISE EXCEPTION 'REPARTO_NO_ENCONTRADO'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  FOR v_det IN SELECT gasto_id FROM utilidades_reparto_detalle WHERE reparto_id=p_reparto_id AND gasto_id IS NOT NULL LOOP
    PERFORM anular_gasto(v_det.gasto_id, COALESCE(p_motivo,'Reparto anulado'));
    v_n := v_n + 1;
  END LOOP;
  UPDATE utilidades_repartos SET anulado=true, updated_at=NOW() WHERE id=p_reparto_id AND tenant_id=v_tenant;
  RETURN jsonb_build_object('anulado', true, 'gastos_revertidos', v_n);
END $$;
REVOKE ALL ON FUNCTION utilidades_anular_reparto(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_anular_reparto(uuid,text) TO authenticated;
COMMIT;
```

- [ ] **Step 2:** Aplicar + verificar. **OJO durante ejecución:** confirmar la firma exacta y el valor de retorno de `crear_gasto` (devuelve el id del gasto como text/uuid?) y de `anular_gasto` (param: `p_gasto_id` o `p_id`?) — ajustar las llamadas. Confirmar que `crear_gasto` con `p_tipo='retiro_socio'` NO lo cuente como gasto operativo en el EERR (el EERR lee tipo='retiro_socio' en su propia línea de Retiros, fuera de la utilidad neta — verificado en el mapa del EERR).
- [ ] **Step 3: Commit** — `feat(utilidades): RPC registrar + anular reparto`

---

## FASE 3 — Calculador

### Task 5: RPC `utilidades_cuanto_repartir`

**Files:**
- Create: `packages/pase/supabase/migrations/202606160500_utilidades_calculador.sql`

- [ ] **Step 1: Escribir la RPC** read-only. Plata total = `cashflow_resumen_mes.posicion.liquido_operativo` + `saldos_finales.utilidades` (el reservado). Obligaciones pendientes del mes = sueldos (liquidaciones del mes estado='pendiente') + facturas fijo del mes pendientes. Colchón = `p_meses_colchon` × (devengado del mes de sueldos + gastos fijos). Seguro = plata_total − obligaciones − colchón.

```sql
-- 202606160500_utilidades_calculador.sql
BEGIN;
CREATE OR REPLACE FUNCTION utilidades_cuanto_repartir(
  p_local_id integer, p_periodo_mes date, p_meses_colchon integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_fin date := (p_periodo_mes + interval '1 month')::date;
  v_mes int := EXTRACT(MONTH FROM p_periodo_mes)::int; v_anio int := EXTRACT(YEAR FROM p_periodo_mes)::int;
  v_resumen jsonb; v_plata numeric; v_reservado numeric;
  v_sueldos_deveng numeric; v_fijos_deveng numeric;
  v_sueldos_pend numeric; v_fijos_pend numeric;
  v_obligaciones numeric; v_colchon numeric; v_seguro numeric; v_ya_repartido numeric;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;

  -- Plata total = líquido operativo (efvo+MP+banco) + reservado (CAJA UTILIDADES).
  v_resumen := cashflow_resumen_mes(p_local_id, p_periodo_mes);
  v_plata := (v_resumen->'posicion'->>'liquido_operativo')::numeric;
  v_reservado := (v_resumen->'saldos_finales'->>'utilidades')::numeric;
  v_plata := v_plata + v_reservado;

  -- Devengado del mes (run-rate): sueldos (liq→nov→empleado.local) + gastos fijos.
  SELECT COALESCE(SUM(liq.total_a_pagar),0) INTO v_sueldos_deveng
  FROM rrhh_liquidaciones liq JOIN rrhh_novedades nov ON nov.id=liq.novedad_id
  JOIN rrhh_empleados emp ON emp.id=nov.empleado_id
  WHERE liq.tenant_id=v_tenant AND emp.local_id=p_local_id AND nov.mes=v_mes AND nov.anio=v_anio
    AND liq.estado IN ('pendiente','pagado') AND liq.anulado=false;
  SELECT COALESCE(SUM(monto),0) INTO v_fijos_deveng FROM gastos
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha>=p_periodo_mes AND fecha<v_fin
     AND tipo='fijo' AND (estado<>'anulado' OR estado IS NULL);
  v_fijos_deveng := v_fijos_deveng + COALESCE((SELECT SUM(total) FROM facturas
     WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha>=p_periodo_mes AND fecha<v_fin
       AND bucket='gasto_fijo' AND (estado<>'anulada' OR estado IS NULL)),0);

  -- Obligaciones pendientes (lo que falta pagar): sueldos pendientes + facturas fijo pendientes.
  SELECT COALESCE(SUM(liq.total_a_pagar),0) INTO v_sueldos_pend
  FROM rrhh_liquidaciones liq JOIN rrhh_novedades nov ON nov.id=liq.novedad_id
  JOIN rrhh_empleados emp ON emp.id=nov.empleado_id
  WHERE liq.tenant_id=v_tenant AND emp.local_id=p_local_id AND nov.mes=v_mes AND nov.anio=v_anio
    AND liq.estado='pendiente' AND liq.anulado=false;
  SELECT COALESCE(SUM(total),0) INTO v_fijos_pend FROM facturas
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND fecha>=p_periodo_mes AND fecha<v_fin
     AND bucket='gasto_fijo' AND estado IN ('pendiente','revision');

  v_obligaciones := v_sueldos_pend + v_fijos_pend;
  v_colchon := GREATEST(p_meses_colchon,0) * (v_sueldos_deveng + v_fijos_deveng);
  v_seguro := v_plata - v_obligaciones - v_colchon;

  SELECT COALESCE(SUM(total),0) INTO v_ya_repartido FROM utilidades_repartos
   WHERE tenant_id=v_tenant AND local_id=p_local_id AND NOT anulado
     AND fecha>=p_periodo_mes AND fecha<v_fin;

  RETURN jsonb_build_object(
    'plata_total', v_plata, 'reservado', v_reservado,
    'obligaciones_pendientes', v_obligaciones,
    'colchon', v_colchon, 'meses_colchon', p_meses_colchon,
    'seguro_repartir', v_seguro,
    'ya_repartido_mes', v_ya_repartido,
    'sobre_distribuido', v_ya_repartido > GREATEST(v_seguro,0)
  );
END $$;
REVOKE ALL ON FUNCTION utilidades_cuanto_repartir(integer,date,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION utilidades_cuanto_repartir(integer,date,integer) TO authenticated;
COMMIT;
```

- [ ] **Step 2:** Aplicar + verificar con Rene (local 5, mayo): la "plata total" debe coincidir con el líquido del cashflow + reservado; comparar el seguro_repartir contra la intuición (en mayo era poco/negativo — la sobre-distribución). **Step 3: Commit** — `feat(utilidades): RPC calculador cuánto repartir`

---

## FASE 4 — Frontend

### Task 6: Servicio `lib/utilidades.ts`

**Files:**
- Create: `packages/pase/src/lib/utilidades.ts`

- [ ] **Step 1:** Wrappers tipados (patrón `lib/cashflow.ts`): `guardarSocio`, `listarSocios` (query directa con `applyLocalScope`), `reservar`, `registrarReparto`, `anularReparto`, `cuantoRepartir`, `listarRepartos`. Interfaces `Socio`, `Reparto`, `CuantoRepartir`. Tipos de retorno explícitos.
- [ ] **Step 2: Commit** — `feat(utilidades): servicio lib/utilidades.ts`

### Task 7: Pantalla `Utilidades.tsx` + nav/route

**Files:**
- Create: `packages/pase/src/pages/Utilidades.tsx`
- Modify: `packages/pase/src/App.tsx` (lazy import + route)
- Modify: `packages/pase/src/components/Layout.tsx` (nav item + SLUG_TO_FEATURE)

- [ ] **Step 1:** Registrar la página (patrón Cashflow): `const Utilidades = lazy(() => import("./pages/Utilidades"))` + `<Route path="/utilidades" element={<Utilidades {...props}/>} />`. En `Layout.tsx`: nav `{slug:"utilidades",path:"/utilidades",label:"Utilidades",sec:"Dirección",icon:"<svg.../>"}` + `SLUG_TO_FEATURE: utilidades: "modulo.reportes"`. **OJO:** `Layout.tsx` puede tener cambios sin commitear de otra sesión — commitear solo el nav (ver técnica `git stash` usada en el cashflow).
- [ ] **Step 2:** Componente: selector mes + local. Arriba: **"Seguro repartir $X"** grande (de `cuantoRepartir`, verde/rojo) + saldo CAJA UTILIDADES (reservado) + "ya repartido este mes" con aviso de sobre-distribución. Lista de socios editable (con aviso si % ≠ 100). Botón **Reservar** (modal: cuenta origen + monto). Botón **Registrar reparto** (modal: total → preview del split por socio ajustable → confirmar). Historial de repartos (tabla, con anular). Reusa componentes `ui/` (PageHeader, StatCard, Card, Modal).
- [ ] **Step 3:** Probar en navegador (dev server). **Step 4: Commit** — `feat(utilidades): pantalla + nav/route`

---

## FASE 5 — Tests

### Task 8: Test E2E mutante

**Files:**
- Create: `packages/pase/tests/utilidades_mutante.spec.ts`

- [ ] **Step 1:** Mutante (patrón `cashflow_mutante.spec.ts`): con `createDuenoClient` + Local Prueba 2, sentinel. Crear 2 socios (60/40), registrar un reparto de $10.000 dividido 6.000/4.000, y assert DB-only: se crearon 2 gastos `tipo='retiro_socio'` (uno por socio), el detalle linkea cada gasto, `total=10000`, y `cuanto_repartir` cuenta el reparto en `ya_repartido_mes`. Anular el reparto → los gastos quedan anulados + reparto.anulado. Cleanup en afterEach (anular reparto → delete reparto cascade → delete socios; cada paso en su try/catch).
- [ ] **Step 2:** `pnpm --filter pase test:e2e:mutante -- utilidades_mutante` → PASS. **Step 3: Commit** — `test(utilidades): e2e mutante reparto + calculador`

### Task 9: Tocar e2e-full

**Files:**
- Create: `packages/pase/tests/e2e-full/sprint-1/46-utilidades-reparto.spec.ts`

- [ ] **Step 1:** Spec e2e-full (patrón `45-cashflow-extracto.spec.ts`): con `loadSharedSeed` + `createE2EDuenoClient`, crear 2 socios, registrar un reparto, verificar los gastos retiro_socio + el detalle + que `cuanto_repartir` lo refleje. INVARIANTE: `Σ utilidades_reparto_detalle.monto = utilidades_repartos.total`. Cleanup en afterAll.
- [ ] **Step 2:** `pnpm --filter pase test:e2e:full -- 46-utilidades-reparto` → PASS. **Step 3: Commit** — `test(utilidades): operación + invariante en e2e-full`

---

## FASE 6 — Cierre

### Task 10: Verificación final + memoria
- [ ] **Step 1:** Smoke en navegador con Rene: definir socios, reservar, registrar un reparto, ver el "seguro repartir" + el reparto en el cashflow (línea Retiros) y el EERR. Confirmar con Lucas.
- [ ] **Step 2:** `pnpm --filter pase typecheck` + `lint` → 0 errores. Deploy Vercel `state=READY`.
- [ ] **Step 3:** Actualizar memoria (módulo Utilidades construido). **Step 4:** Commit final.

---

## Self-review notes (gaps a confirmar durante ejecución)
- **`saldos_caja` ON CONFLICT** (Task 3): confirmar el nombre/columnas de la unique constraint real antes de aplicar.
- **Firma de `crear_gasto`/`anular_gasto`** (Task 4): confirmar el tipo de retorno de `crear_gasto` (id text vs uuid) y el nombre del param de `anular_gasto`. La categoría 'RETIROS DE SOCIOS' debe existir o crear_gasto aceptar texto libre — verificar.
- **Obligaciones/colchón del calculador** (Task 5): la definición es un MVP razonable; validar los números contra Rene y ajustar (ej. incluir alquiler si está en otra categoría, no solo 'fijo').
- **CAJA UTILIDADES negativa**: si se reparte de CAJA UTILIDADES sin reservar suficiente, queda negativa (igual que las otras cajas). No se bloquea; el calculador avisa.
- **Capa 3 (apartado automático)**: spec + plan propios, futuros.
