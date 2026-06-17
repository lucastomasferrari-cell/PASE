# Cierre / bloqueo de mes — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir cerrar un mes por local y, a partir de ahí, bloquear crear/editar/anular cualquier dato financiero (ventas, facturas, remitos, gastos, sueldos, movimientos) con fecha en ese mes — con reapertura para dueño/admin.

**Architecture:** Tabla `periodos_cerrados` (existe la fila = mes cerrado) + RPCs `cerrar_periodo`/`reabrir_periodo`. El bloqueo lo hace un **trigger guardián** `fn_guard_periodo_cerrado()` (genérico, vía `to_jsonb(NEW/OLD)`) en las 5 tablas con `fecha`+`local_id`, y un guard específico para `rrhh_liquidaciones` (resuelve mes/local por novedad+empleado). **Bypass reusando el GUC existente `pase.skip_orphan_guard`** (que `eliminar_tenant_completo` ya setea → cubre borrado de tenant y teardown de tests sin tocar esa función). Frontend: servicio `lib/periodos.ts` + botón en Reportes.

**Tech Stack:** Supabase (Postgres + RLS + triggers), React 19 + TS, Playwright (mutante + e2e-full).

**Spec:** `docs/superpowers/specs/2026-06-16-cierre-bloqueo-mes-design.md` (leer antes de empezar).

**Reglas del repo:** RPCs atómicas SECURITY DEFINER con auth check + `REVOKE FROM PUBLIC, anon` (C11), error codes UPPER_SNAKE (C9) mapeados en `errors.ts`, tabla nueva con checklist (RLS dual, columnas estándar — C7), test mutante (C2) + tocar e2e-full. Migraciones por el flujo oficial (`vercel env pull` → script `pg`). Al commitear: `git add <ruta>` explícito (NO `-A`; hay cambios sin commitear de otra sesión en `Layout.tsx`/`Compras.tsx`).

---

## File Structure

- **Create** `packages/pase/supabase/migrations/202606160600_periodos_cerrados_schema.sql` — tabla + RLS + `fn_periodo_esta_cerrado`.
- **Create** `packages/pase/supabase/migrations/202606160700_periodos_rpcs.sql` — `cerrar_periodo` + `reabrir_periodo`.
- **Create** `packages/pase/supabase/migrations/202606160800_periodos_guard_triggers.sql` — guards + triggers en las 6 tablas.
- **Create** `packages/pase/src/lib/periodos.ts` — servicio tipado.
- **Modify** `packages/pase/src/lib/errors.ts` — mapear `PERIODO_CERRADO` + `SOLO_DUENO_ADMIN`.
- **Modify** `packages/pase/src/pages/EERR.tsx` — botón Cerrar/Reabrir mes + indicador (dueño/admin).
- **Create** `packages/pase/tests/periodo_cerrado_mutante.spec.ts` — mutante.
- **Create** `packages/pase/tests/e2e-full/sprint-1/47-cierre-periodo.spec.ts` — e2e-full.

---

## FASE 1 — Schema + helper

### Task 1: Tabla `periodos_cerrados` + `fn_periodo_esta_cerrado`

**Files:**
- Create: `packages/pase/supabase/migrations/202606160600_periodos_cerrados_schema.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 202606160600_periodos_cerrados_schema.sql
-- Cierre de período: una fila por (tenant, local, mes) = ese mes está cerrado.
BEGIN;

CREATE TABLE IF NOT EXISTS periodos_cerrados (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  local_id     INTEGER NOT NULL,
  periodo_mes  DATE NOT NULL,                 -- primer día del mes cerrado
  cerrado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cerrado_por  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, periodo_mes)
);
CREATE INDEX IF NOT EXISTS idx_periodos_cerrados_local ON periodos_cerrados(local_id, periodo_mes);

ALTER TABLE periodos_cerrados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS periodos_cerrados_all ON periodos_cerrados;
CREATE POLICY periodos_cerrados_all ON periodos_cerrados FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

-- Helper que usan los triggers (SECURITY DEFINER → ve la tabla sin RLS).
CREATE OR REPLACE FUNCTION fn_periodo_esta_cerrado(p_local_id integer, p_fecha date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM periodos_cerrados
    WHERE local_id = p_local_id
      AND periodo_mes = date_trunc('month', p_fecha)::date
  );
$$;

COMMIT;
```

- [ ] **Step 2: Aplicar + verificar.** Flujo oficial (`vercel env pull .env.local.tmp` → script `pg`). Verificaciones: `to_regclass('public.periodos_cerrados')` no-null; RLS habilitado; policy `periodos_cerrados_all` existe; `fn_periodo_esta_cerrado` existe. Borrar `.env.local.tmp` + script.
- [ ] **Step 3: Commit** — `git add packages/pase/supabase/migrations/202606160600_periodos_cerrados_schema.sql && git commit -m "feat(cierre-mes): tabla periodos_cerrados + fn_periodo_esta_cerrado"`

---

## FASE 2 — RPCs cerrar / reabrir

### Task 2: `cerrar_periodo` + `reabrir_periodo`

**Files:**
- Create: `packages/pase/supabase/migrations/202606160700_periodos_rpcs.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 202606160700_periodos_rpcs.sql
BEGIN;
CREATE OR REPLACE FUNCTION cerrar_periodo(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_mes date := date_trunc('month', p_periodo_mes)::date;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  INSERT INTO periodos_cerrados (tenant_id, local_id, periodo_mes, cerrado_por)
  VALUES (v_tenant, p_local_id, v_mes, auth_usuario_id())
  ON CONFLICT (tenant_id, local_id, periodo_mes) DO NOTHING;
  RETURN jsonb_build_object('cerrado', true, 'local_id', p_local_id, 'periodo_mes', v_mes);
END $$;
REVOKE ALL ON FUNCTION cerrar_periodo(integer,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cerrar_periodo(integer,date) TO authenticated;

CREATE OR REPLACE FUNCTION reabrir_periodo(p_local_id integer, p_periodo_mes date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_mes date := date_trunc('month', p_periodo_mes)::date; v_n int;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT auth_es_dueno_o_admin() THEN RAISE EXCEPTION 'SOLO_DUENO_ADMIN'; END IF;
  DELETE FROM periodos_cerrados
   WHERE tenant_id = v_tenant AND local_id = p_local_id AND periodo_mes = v_mes;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM _auditar('periodos_cerrados', 'REABRIR', jsonb_build_object(
    'local_id', p_local_id, 'periodo_mes', v_mes, 'usuario_id', auth_usuario_id()), v_tenant);
  RETURN jsonb_build_object('reabierto', true, 'local_id', p_local_id, 'periodo_mes', v_mes, 'borradas', v_n);
END $$;
REVOKE ALL ON FUNCTION reabrir_periodo(integer,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reabrir_periodo(integer,date) TO authenticated;
COMMIT;
```

- [ ] **Step 2: Aplicar + verificar.** Ambas existen, `prosecdef=true`, `has_function_privilege('authenticated', oid, 'EXECUTE')=true`, `anon/public=false`. **OJO durante ejecución:** confirmar la firma de `_auditar` (`_auditar(text,text,jsonb,uuid)`) y que `auth_usuario_id()` exista (se usan ambas en `crear_gasto`).
- [ ] **Step 3: Commit** — `git add ...202606160700_periodos_rpcs.sql && git commit -m "feat(cierre-mes): RPCs cerrar_periodo + reabrir_periodo"`

---

## FASE 3 — Enforcement (guard triggers)

### Task 3: Guard genérico + guard de sueldos + triggers

**Files:**
- Create: `packages/pase/supabase/migrations/202606160800_periodos_guard_triggers.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 202606160800_periodos_guard_triggers.sql
-- Bloquea crear/editar/anular datos con fecha en un mes cerrado.
-- Bypass: reusa el GUC pase.skip_orphan_guard (eliminar_tenant_completo ya lo
-- setea → cubre borrado de tenant y teardown de tests sin tocar esa función).
BEGIN;

-- Guard genérico para tablas con local_id + fecha (ventas, facturas, remitos, gastos, movimientos).
CREATE OR REPLACE FUNCTION fn_guard_periodo_cerrado()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_j jsonb; v_local int; v_fecha date;
BEGIN
  IF current_setting('pase.skip_orphan_guard', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_j := to_jsonb(NEW);
    v_local := NULLIF(v_j->>'local_id','')::int;
    v_fecha := NULLIF(v_j->>'fecha','')::date;
    IF v_local IS NOT NULL AND v_fecha IS NOT NULL AND fn_periodo_esta_cerrado(v_local, v_fecha) THEN
      RAISE EXCEPTION 'PERIODO_CERRADO' USING DETAIL =
        format('%s con fecha %s cae en un mes cerrado (local %s).', TG_TABLE_NAME, v_fecha, v_local);
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_j := to_jsonb(OLD);
    v_local := NULLIF(v_j->>'local_id','')::int;
    v_fecha := NULLIF(v_j->>'fecha','')::date;
    IF v_local IS NOT NULL AND v_fecha IS NOT NULL AND fn_periodo_esta_cerrado(v_local, v_fecha) THEN
      RAISE EXCEPTION 'PERIODO_CERRADO' USING DETAIL =
        format('%s con fecha %s cae en un mes cerrado (local %s).', TG_TABLE_NAME, v_fecha, v_local);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- Guard específico para rrhh_liquidaciones (sin fecha/local_id directos):
-- resuelve por la novedad (mes/anio) + el empleado (local_id).
CREATE OR REPLACE FUNCTION fn_guard_periodo_cerrado_liquidacion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rec rrhh_liquidaciones; v_local int; v_fecha date;
BEGIN
  IF current_setting('pase.skip_orphan_guard', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  v_rec := COALESCE(NEW, OLD);
  SELECT emp.local_id, make_date(nov.anio, nov.mes, 1)
    INTO v_local, v_fecha
  FROM rrhh_novedades nov JOIN rrhh_empleados emp ON emp.id = nov.empleado_id
  WHERE nov.id = v_rec.novedad_id;
  IF v_local IS NOT NULL AND v_fecha IS NOT NULL AND fn_periodo_esta_cerrado(v_local, v_fecha) THEN
    RAISE EXCEPTION 'PERIODO_CERRADO' USING DETAIL =
      format('Sueldo de un mes cerrado (local %s, %s).', v_local, v_fecha);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- Triggers en las 5 tablas con fecha+local_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ventas','facturas','remitos','gastos','movimientos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_periodo_cerrado ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_periodo_cerrado BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fn_guard_periodo_cerrado()', t);
  END LOOP;
END $$;

-- Trigger en rrhh_liquidaciones.
DROP TRIGGER IF EXISTS trg_periodo_cerrado_liq ON rrhh_liquidaciones;
CREATE TRIGGER trg_periodo_cerrado_liq BEFORE INSERT OR UPDATE OR DELETE ON rrhh_liquidaciones
  FOR EACH ROW EXECUTE FUNCTION fn_guard_periodo_cerrado_liquidacion();

COMMIT;
```

- [ ] **Step 2: Aplicar + verificar.** **OJO durante ejecución:** ANTES de aplicar, confirmar por introspección que `ventas`, `facturas`, `remitos`, `gastos`, `movimientos` tienen columnas `local_id` y `fecha` (si alguna no la tiene, sacarla del array y anotarlo). Verificar: los 6 triggers existen (`pg_trigger` en cada tabla); las 2 funciones guard existen. **Smoke lógico** (transacción con ROLLBACK, sin auth): `BEGIN; INSERT INTO periodos_cerrados(tenant_id,local_id,periodo_mes) SELECT tenant_id, id, '2031-07-01' FROM locales WHERE nombre='Local Prueba 2'; SELECT fn_periodo_esta_cerrado((SELECT id FROM locales WHERE nombre='Local Prueba 2'), '2031-07-15') AS debe_ser_true; ROLLBACK;` → debe dar `true`.
- [ ] **Step 3: Commit** — `git add ...202606160800_periodos_guard_triggers.sql && git commit -m "feat(cierre-mes): guard triggers de periodo en tablas de plata"`

---

## FASE 4 — Frontend

### Task 4: Servicio `lib/periodos.ts`

**Files:**
- Create: `packages/pase/src/lib/periodos.ts`

- [ ] **Step 1: Escribir el servicio**

```ts
// periodos.ts — cierre/bloqueo de mes. Wrappers de las RPCs + consulta de estado.
import { db } from "./supabase";

type R<T> = Promise<{ data: T | null; error: string | null }>;

const aMesISO = (mes: string) => `${mes.slice(0, 7)}-01`; // "YYYY-MM" | "YYYY-MM-DD" → "YYYY-MM-01"

export async function cerrarPeriodo(localId: number, mes: string): R<{ cerrado: boolean }> {
  const { data, error } = await db.rpc("cerrar_periodo", { p_local_id: localId, p_periodo_mes: aMesISO(mes) });
  return { data: (data as { cerrado: boolean } | null), error: error?.message ?? null };
}

export async function reabrirPeriodo(localId: number, mes: string): R<{ reabierto: boolean }> {
  const { data, error } = await db.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: aMesISO(mes) });
  return { data: (data as { reabierto: boolean } | null), error: error?.message ?? null };
}

export async function estaCerrado(localId: number, mes: string): R<boolean> {
  const { data, error } = await db
    .from("periodos_cerrados")
    .select("id")
    .eq("local_id", localId)
    .eq("periodo_mes", aMesISO(mes))
    .maybeSingle();
  return { data: !!data, error: error?.message ?? null };
}
```

- [ ] **Step 2: Verificar** `pnpm --filter pase typecheck` → sin errores. **Step 3: Commit** — `git add packages/pase/src/lib/periodos.ts && git commit -m "feat(cierre-mes): servicio lib/periodos.ts"`

### Task 5: Mapear errores + botón en Reportes

**Files:**
- Modify: `packages/pase/src/lib/errors.ts`
- Modify: `packages/pase/src/pages/EERR.tsx`

- [ ] **Step 1: Mapear los códigos.** En `src/lib/errors.ts`, en el objeto/map que usa `translateRpcError` (buscar dónde están las entradas tipo `FACTURA_YA_PAGADA: "..."`), agregar:

```ts
  PERIODO_CERRADO: "Ese mes está cerrado. Reabrilo desde Reportes para poder modificarlo.",
  SOLO_DUENO_ADMIN: "Solo el dueño o un administrador puede cerrar o reabrir un mes.",
```

- [ ] **Step 2: Importar el servicio + helpers en `EERR.tsx`.** Junto a los otros imports:

```tsx
import { estaCerrado, cerrarPeriodo, reabrirPeriodo } from "../lib/periodos";
import { translateRpcError } from "../lib/errors";
```
(Si `translateRpcError` ya está importado, no duplicar.)

- [ ] **Step 3: Estado + carga del cierre.** Cerca de los otros `useState` del componente `EERR` (después de `const [simulando,setSimulando]=useState(false);`):

```tsx
const [mesCerrado, setMesCerrado] = useState(false);
const [cerrandoMes, setCerrandoMes] = useState(false);
const esDuenoAdmin = user.rol === "dueno" || user.rol === "admin";
```

Y un efecto que carga el estado del cierre cuando cambia mes/local (agregar después del `useEffect` principal de carga de datos):

```tsx
useEffect(() => {
  if (localActivo == null) { setMesCerrado(false); return; }
  let cancel = false;
  estaCerrado(localActivo, mes).then(({ data }) => { if (!cancel) setMesCerrado(!!data); });
  return () => { cancel = true; };
}, [mes, localActivo]);
```

- [ ] **Step 4: Botón Cerrar/Reabrir en la barra de acciones.** Justo después del botón "Simular escenario" (`{simulando ? "Cerrar simulador" : "Simular escenario"}` ... `</button>`), agregar:

```tsx
{esDuenoAdmin && (
  <button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11}}
    disabled={localActivo == null || cerrandoMes}
    title={localActivo == null ? "Elegí un local para cerrar el mes" : (mesCerrado ? "Reabrir el mes para poder modificarlo" : "Cerrar el mes: bloquea cambios con fecha en este mes")}
    onClick={async () => {
      if (localActivo == null) return;
      const cerrar = !mesCerrado;
      if (cerrar && !confirm(`¿Cerrar ${mes}? No se va a poder crear ni editar nada con fecha en ese mes hasta reabrirlo.`)) return;
      setCerrandoMes(true);
      const { error } = cerrar
        ? await cerrarPeriodo(localActivo, mes)
        : await reabrirPeriodo(localActivo, mes);
      setCerrandoMes(false);
      if (error) { alert(translateRpcError(error)); return; }
      setMesCerrado(cerrar);
    }}>
    {cerrandoMes ? "..." : (mesCerrado ? "🔓 Reabrir mes" : "🔒 Cerrar mes")}
  </button>
)}
```

- [ ] **Step 5: Indicador "mes cerrado".** Dentro del bloque de contenido (después de `<>` y del render del simulador), agregar un aviso visible cuando el mes está cerrado:

```tsx
{mesCerrado && (
  <div style={{margin:"4px 0 12px",padding:"6px 12px",borderRadius:8,background:"rgba(117,170,219,0.12)",fontSize:12,color:"var(--pase-text)"}}>
    🔒 Mes cerrado — no se pueden crear ni editar datos con fecha en {mes}. Reabrilo para modificarlo.
  </div>
)}
```

- [ ] **Step 6: Verificar** `pnpm --filter pase typecheck` + `npx eslint src/pages/EERR.tsx src/lib/periodos.ts src/lib/errors.ts` (0 errores en lo nuevo) + `pnpm --filter pase build` (✓ built).
- [ ] **Step 7: Commit** — `git add packages/pase/src/lib/errors.ts packages/pase/src/pages/EERR.tsx && git commit -m "feat(cierre-mes): boton Cerrar/Reabrir mes en Reportes + errores"`

---

## FASE 5 — Tests

### Task 6: Test mutante

**Files:**
- Create: `packages/pase/tests/periodo_cerrado_mutante.spec.ts`

- [ ] **Step 1: Escribir el mutante** (patrón `*_mutante.spec.ts`: `createDuenoClient` + Local Prueba 2 + período aislado 2031-07).

```ts
import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Cierre de mes: cerrar 2031-07 en Local Prueba 2 → crear_gasto con fecha en ese
// mes es rechazado (PERIODO_CERRADO); reabrir → se puede; cleanup completo.
const LOCAL = "Local Prueba 2";
const MES = "2031-07-01";
const FECHA = "2031-07-15";
const SENT = "ZZMUTPERIODO";

test.describe("Cierre de mes — mutante (bloqueo + reapertura)", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    tenantId = locs[0].tenant_id as string;
    await limpiar();
  });

  test.afterEach(async () => {
    await limpiar();
    try { await db.auth.signOut(); } catch { /* */ }
  });

  async function limpiar() {
    // Reabrir primero (si no, el guard bloquea el borrado de los gastos del mes).
    await db.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES }).then(() => {}, () => {});
    // Borrar los gastos de prueba (+ sus movimientos).
    const { data: gs } = await db.from("gastos").select("id").eq("local_id", localId).eq("detalle", SENT);
    const ids = (gs ?? []).map((g) => g.id as string);
    if (ids.length) {
      await db.from("movimientos").delete().in("gasto_id_ref", ids).then(() => {}, () => {});
      await db.from("gastos").delete().in("id", ids).then(() => {}, () => {});
    }
  }

  test("cerrar bloquea crear_gasto en el mes; reabrir lo permite", async () => {
    // 1. Cerrar el mes.
    const { error: eCerrar } = await db.rpc("cerrar_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eCerrar).toBeNull();

    // 2. crear_gasto con fecha en el mes cerrado → PERIODO_CERRADO.
    const { error: eGasto } = await db.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eGasto).not.toBeNull();
    expect(String(eGasto?.message)).toContain("PERIODO_CERRADO");

    // 3. Reabrir el mes.
    const { error: eReabrir } = await db.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eReabrir).toBeNull();

    // 4. Ahora crear_gasto sí funciona.
    const { data: ok, error: eOk } = await db.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eOk).toBeNull();
    expect((ok as { gasto_id: string }).gasto_id).toBeTruthy();
  });
});
```

- [ ] **Step 2:** `pnpm --filter pase test:e2e:mutante -- periodo_cerrado_mutante` → PASS. **OJO:** si `crear_gasto` rechaza la categoría "Varios"/tipo "variable" (por el normalizador de `crear_gasto`, fix 16-jun), usar una categoría/tipo que el normalizador acepte (ej. `p_tipo:"variable"` ya es canónico; si falla, revisar el set válido). **Step 3: Commit** — `git add packages/pase/tests/periodo_cerrado_mutante.spec.ts && git commit -m "test(cierre-mes): mutante bloqueo + reapertura"`

### Task 7: Tocar e2e-full

**Files:**
- Create: `packages/pase/tests/e2e-full/sprint-1/47-cierre-periodo.spec.ts`

- [ ] **Step 1: Escribir el spec** (patrón `46-utilidades-reparto.spec.ts`: `loadSharedSeed` + `createE2EDuenoClient`, período aislado 2031-08).

```ts
import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2EDuenoClient } from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

// E2E Test 47 — CIERRE DE MES: cerrar un mes bloquea crear_gasto con fecha en él;
// reabrir lo permite. INVARIANTE: con el mes cerrado, el INSERT financiero falla.
const MES = "2031-08-01";
const FECHA = "2031-08-15";
const SENT = "ZZE2EPERIODO47";

test.describe.serial("E2E Test 47 — CIERRE DE MES: bloqueo + reapertura", () => {
  let duenoDb: SupabaseClient;
  let localId: number;

  test.beforeAll(async () => {
    const seed = loadSharedSeed();
    localId = seed.local1Id;
    duenoDb = await createE2EDuenoClient();
  });

  test.afterAll(async () => {
    await duenoDb.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES }).then(() => {}, () => {});
    const { data: gs } = await duenoDb.from("gastos").select("id").eq("local_id", localId).eq("detalle", SENT);
    const ids = (gs ?? []).map((g) => g.id as string);
    if (ids.length) {
      await duenoDb.from("movimientos").delete().in("gasto_id_ref", ids).then(() => {}, () => {});
      await duenoDb.from("gastos").delete().in("id", ids).then(() => {}, () => {});
    }
    try { await duenoDb.auth.signOut(); } catch { /* */ }
  });

  test("cerrar bloquea el INSERT financiero; reabrir lo permite", async () => {
    const { error: eCerrar } = await duenoDb.rpc("cerrar_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eCerrar).toBeNull();

    const { error: eGasto } = await duenoDb.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(String(eGasto?.message)).toContain("PERIODO_CERRADO"); // INVARIANTE

    const { error: eReabrir } = await duenoDb.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: MES });
    expect(eReabrir).toBeNull();

    const { data: ok, error: eOk } = await duenoDb.rpc("crear_gasto", {
      p_fecha: FECHA, p_local_id: localId, p_categoria: "Varios", p_tipo: "variable",
      p_monto: 1000, p_detalle: SENT, p_cuenta: "Caja Mayor", p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eOk).toBeNull();
    expect((ok as { gasto_id: string }).gasto_id).toBeTruthy();
  });
});
```

- [ ] **Step 2:** `pnpm --filter pase test:e2e:full -- 47-cierre-periodo` → PASS. **Step 3: Commit** — `git add packages/pase/tests/e2e-full/sprint-1/47-cierre-periodo.spec.ts && git commit -m "test(cierre-mes): e2e-full bloqueo + reapertura"`

---

## FASE 6 — Cierre

### Task 8: Verificación final + memoria
- [ ] **Step 1:** `pnpm --filter pase typecheck` + `build` OK; mutante + e2e-full verdes.
- [ ] **Step 2:** Push a `main`; verificar deploy Vercel `state=READY` (`npx vercel ls`).
- [ ] **Step 3:** Actualizar memoria (`project_pase_*` cierre de mes construido) + `MEMORY.md`. Registrar en pendientes el **smoke de Lucas** (Reportes → Cerrar mes → intentar cargar un gasto con fecha en ese mes → ver el bloqueo → Reabrir).

---

## Self-review notes
- **Cobertura de la spec:** tabla `periodos_cerrados` ✅ (Task 1), RPCs cerrar/reabrir dueño/admin ✅ (Task 2), guard en las 6 tablas ✅ (Task 3), sueldos vía novedad/empleado ✅ (Task 3), frontend en Reportes ✅ (Task 5), error mapeado ✅ (Task 5), mutante + e2e-full ✅ (Tasks 6-7). Casos borde: bypass tenant ✅ (reuso `pase.skip_orphan_guard`).
- **Desvío vs spec:** la spec proponía un GUC nuevo `pase.skip_periodo_guard`; el plan **reusa `pase.skip_orphan_guard`** (ya seteado por `eliminar_tenant_completo`) para NO re-escribir esa función de 190 líneas — más simple y menos riesgo. Mismo efecto. (Actualizar la nota de la spec si se quiere.)
- **Consistencia de tipos:** `cerrar_periodo(integer,date)` / `reabrir_periodo(integer,date)` usadas igual en RPCs, servicio (`p_local_id`,`p_periodo_mes`) y tests. `fn_periodo_esta_cerrado(int,date)→bool` usada en los 2 guards. Error `PERIODO_CERRADO` consistente en guard + mapeo + tests.
- **Placeholders:** ninguno; todo el SQL/TS está completo. Los anclajes en `EERR.tsx`/`errors.ts` indican el texto a buscar.
- **Riesgo conocido:** los triggers sobre `ventas`/`movimientos` corren en cada escritura financiera — `fn_periodo_esta_cerrado` es un EXISTS indexado (barato). Confirmar columnas `fecha`/`local_id` por introspección antes de aplicar (Task 3 Step 2).
```
