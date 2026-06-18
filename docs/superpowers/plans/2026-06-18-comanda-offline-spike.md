# COMANDA Offline Rebuild — Fase 0 (Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Es un SPIKE: exploratorio y descartable.** El objetivo NO es código de producción sino VALIDAR un motor local-first y entregar un informe de decisión. Algunos pasos son "construir y medir", no TDD estricto.

**Goal:** Construir UN circuito (abrir mesa → agregar ítem → cobrar) end-to-end sobre un motor local-first (RxDB primero; PowerSync cuando haya instancia), aislado de producción, y decidir con evidencia qué motor usar para el rebuild — validando 6 criterios (instantáneo / offline real / sobrevive recarga / reconcilia sin duplicados / RLS / costo).

**Architecture:** Sandbox aislado en `packages/comanda/src/spike-offline/` + una ruta gateada `/pos/_spike-offline` (no linkeada en el nav). La UI lee/escribe de un store local del motor (instantáneo por construcción); el motor sincroniza con Supabase en background. NO toca los `services/` ni `offline/` actuales. Corre contra un local de prueba, nunca data real.

**Tech Stack:** React 19 + Vite 8 + react-router 7 + Supabase (supabase-js 2.103) + **RxDB** (motor 1) + **PowerSync** (motor 2, requiere instancia). vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-18-comanda-offline-rebuild-design.md` (leer antes de empezar).

**Reglas del repo:** todo en COMANDA detrás de la ruta gateada (no afecta prod). Push directo a main; verificar deploy READY de COMANDA. El spike NO necesita test mutante/e2e de plata (es throwaway, no se prende ningún flag); la "prueba" son los 6 criterios validados a mano + un test offline mínimo con vitest. Commitear solo los archivos del spike con `git add <ruta>` explícito (hay cambios sin commitear de otra sesión en el working tree).

---

## Prerequisito manual de Lucas (para la parte PowerSync — NO bloquea el arranque)
- [ ] **Lucas: crear cuenta + instancia PowerSync y conectarla a la DB Supabase.** Necesario SOLO para la Tarea 5 (evaluación PowerSync). El spike arranca y valida todo con RxDB sin esto. Pasos (PowerSync Cloud → New Instance → conectar al Postgres de Supabase con la connection string `POSTGRES_URL_NON_POOLING` + crear las "sync rules" mínimas para `ventas_pos`/`ventas_pos_items`/`ventas_pos_pagos`). Guía oficial: https://docs.powersync.com/integration-guides/supabase-+-powersync . Dejar las credenciales (instance URL + dev token) en `packages/comanda/.env.local` como `VITE_POWERSYNC_URL`. **Registrar esto en `project_tareas_manuales_pendientes.md`.**

---

## File Structure
- **Create** `packages/comanda/src/spike-offline/schema.ts` — schemas RxDB de las 3 tablas (subset real introspectado).
- **Create** `packages/comanda/src/spike-offline/db.ts` — crea la RxDatabase + colecciones.
- **Create** `packages/comanda/src/spike-offline/replication.ts` — wiring pull/push contra Supabase.
- **Create** `packages/comanda/src/spike-offline/flow.ts` — operaciones `abrirMesa` / `agregarItem` / `cobrar` contra el store local.
- **Create** `packages/comanda/src/spike-offline/SpikeOfflinePage.tsx` — UI mínima: corre el flujo, muestra el estado local en vivo, checklist de criterios.
- **Create** `packages/comanda/src/spike-offline/flow.test.ts` — test vitest del flujo offline (sin red).
- **Modify** `packages/comanda/src/App.tsx` — ruta lazy gateada `/pos/_spike-offline`.
- **Create (entregable final)** `docs/superpowers/2026-06-18-comanda-offline-spike-resultado.md` — informe de decisión.

---

## Task 1: Scaffold del sandbox aislado + ruta gateada

**Files:**
- Create: `packages/comanda/src/spike-offline/SpikeOfflinePage.tsx`
- Modify: `packages/comanda/src/App.tsx`

- [ ] **Step 1: Página placeholder del spike**

```tsx
// packages/comanda/src/spike-offline/SpikeOfflinePage.tsx
// SPIKE OFFLINE (descartable) — sandbox aislado para validar un motor local-first.
// NO es producción. No linkeado en el nav. Borrar al cerrar la Fase 0.
export function SpikeOfflinePage() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Spike Offline — sandbox</h1>
      <p>Validación de motor local-first (RxDB / PowerSync). No es producción.</p>
    </div>
  );
}
```

- [ ] **Step 2: Registrar la ruta gateada en `App.tsx`.** Junto a los otros `lazy(...)` agregar el import, y dentro del `<Routes>` agregar la ruta SOLO en dev o para superadmin (gate simple: `import.meta.env.DEV`).

```tsx
// con los otros lazy() arriba:
const SpikeOfflinePage = lazy(() => import('./spike-offline/SpikeOfflinePage').then(m => ({ default: m.SpikeOfflinePage })));

// dentro de <Routes>, solo en dev:
{import.meta.env.DEV && <Route path="/pos/_spike-offline" element={<SpikeOfflinePage />} />}
```

- [ ] **Step 3: Verificar** `pnpm --filter comanda dev` → abrir `http://localhost:5174/pos/_spike-offline` → se ve el placeholder. `pnpm --filter comanda typecheck` sin errores.
- [ ] **Step 4: Commit** — `git add packages/comanda/src/spike-offline/SpikeOfflinePage.tsx packages/comanda/src/App.tsx && git commit -m "spike(offline): scaffold sandbox aislado + ruta gateada"`

---

## Task 2: Introspectar el schema real + schemas RxDB

**Files:**
- Create: `packages/comanda/src/spike-offline/schema.ts`

- [ ] **Step 1: Introspectar columnas reales** de `ventas_pos`, `ventas_pos_items`, `ventas_pos_pagos` (para que el store local matchee Supabase). Usar el flujo oficial de migraciones (`vercel env pull .env.local.tmp` en `packages/pase` → script `pg` one-off que corre `SELECT column_name, data_type FROM information_schema.columns WHERE table_name IN ('ventas_pos','ventas_pos_items','ventas_pos_pagos') ORDER BY table_name, ordinal_position;`). Anotar las columnas + PK + la columna de orden/updated para el checkpoint del sync (`updated_at` o equivalente; si no hay, usar `created_at`). Borrar el `.tmp` y el script.

- [ ] **Step 2: Escribir los schemas RxDB** con el subset mínimo para el flujo. RxDB exige un schema JSON por colección (campo `primaryKey`, `properties`, `required`). Ejemplo (AJUSTAR los nombres/tipos a lo introspectado en Step 1):

```ts
// packages/comanda/src/spike-offline/schema.ts
import type { RxJsonSchema } from 'rxdb';

export interface VentaDoc { id: string; local_id: number; mesa_id: string | null; estado: string; total: number; updated_at: string; }
export interface ItemDoc { id: string; venta_id: string; item_id: string; nombre: string; precio: number; cantidad: number; curso: number; updated_at: string; }
export interface PagoDoc { id: string; venta_id: string; medio: string; monto: number; updated_at: string; }

export const ventaSchema: RxJsonSchema<VentaDoc> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    local_id: { type: 'number' },
    mesa_id: { type: ['string', 'null'] },
    estado: { type: 'string' },
    total: { type: 'number' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['id', 'local_id', 'estado', 'total', 'updated_at'],
};

export const itemSchema: RxJsonSchema<ItemDoc> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    venta_id: { type: 'string', maxLength: 64 },
    item_id: { type: 'string', maxLength: 64 },
    nombre: { type: 'string' }, precio: { type: 'number' },
    cantidad: { type: 'number' }, curso: { type: 'number' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['id', 'venta_id', 'item_id', 'precio', 'cantidad', 'updated_at'],
};

export const pagoSchema: RxJsonSchema<PagoDoc> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    venta_id: { type: 'string', maxLength: 64 },
    medio: { type: 'string' }, monto: { type: 'number' },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['id', 'venta_id', 'medio', 'monto', 'updated_at'],
};
```

- [ ] **Step 3: Commit** — `git add packages/comanda/src/spike-offline/schema.ts && git commit -m "spike(offline): schemas RxDB (subset real de ventas_pos/items/pagos)"`

---

## Task 3: RxDB local + replicación Supabase

**Files:**
- Create: `packages/comanda/src/spike-offline/db.ts`
- Create: `packages/comanda/src/spike-offline/replication.ts`

- [ ] **Step 1: Instalar RxDB** — `pnpm --filter comanda add rxdb` (storage IndexedDB Dexie incluido en RxDB; usar `getRxStorageDexie()`).

- [ ] **Step 2: Crear la RxDatabase + colecciones** (`db.ts`):

```ts
// packages/comanda/src/spike-offline/db.ts
import { createRxDatabase, addRxPlugin, type RxDatabase } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { ventaSchema, itemSchema, pagoSchema } from './schema';

if (import.meta.env.DEV) addRxPlugin(RxDBDevModePlugin);

export type SpikeDB = RxDatabase;

export async function crearSpikeDB(): Promise<SpikeDB> {
  const db = await createRxDatabase({
    name: 'comanda-spike',
    storage: getRxStorageDexie(),
    ignoreDuplicate: import.meta.env.DEV,
  });
  await db.addCollections({
    ventas: { schema: ventaSchema },
    items: { schema: itemSchema },
    pagos: { schema: pagoSchema },
  });
  return db;
}
```

- [ ] **Step 3: Wiring de replicación con Supabase** (`replication.ts`) usando `replicateRxCollection` de RxDB (pull = traer filas con `updated_at` > checkpoint vía supabase-js; push = upsert). Hacerlo para las 3 colecciones. Esqueleto para `ventas` (replicar igual para items/pagos cambiando tabla/colección):

```ts
// packages/comanda/src/spike-offline/replication.ts
import { replicateRxCollection } from 'rxdb/plugins/replication';
import { db as supa } from '../lib/supabase';
import type { SpikeDB } from './db';

const BATCH = 50;

export function startReplication(db: SpikeDB) {
  const handles = [
    repl(db, 'ventas', 'ventas_pos'),
    repl(db, 'items', 'ventas_pos_items'),
    repl(db, 'pagos', 'ventas_pos_pagos'),
  ];
  return () => handles.forEach((h) => h.cancel());
}

function repl(db: SpikeDB, col: string, table: string) {
  return replicateRxCollection({
    collection: db[col],
    replicationIdentifier: `spike-${table}`,
    live: true,
    retryTime: 5000,
    pull: {
      batchSize: BATCH,
      async handler(checkpoint: { updated_at: string } | undefined, limit: number) {
        const since = checkpoint?.updated_at ?? '1970-01-01';
        const { data, error } = await supa.from(table)
          .select('*').gt('updated_at', since).order('updated_at', { ascending: true }).limit(limit);
        if (error) throw error;
        const docs = data ?? [];
        return {
          documents: docs,
          checkpoint: docs.length ? { updated_at: docs[docs.length - 1].updated_at } : checkpoint,
        };
      },
    },
    push: {
      batchSize: BATCH,
      async handler(rows: { newDocumentState: Record<string, unknown> }[]) {
        const payload = rows.map((r) => r.newDocumentState);
        const { error } = await supa.from(table).upsert(payload, { onConflict: 'id' });
        if (error) throw error;
        return []; // sin conflict-detection en el spike (server-authoritative LWW)
      },
    },
  });
}
```

- [ ] **Step 4: Verificar** `pnpm --filter comanda typecheck`. **OJO durante ejecución:** confirmar el nombre real de la columna de orden (`updated_at`) por la introspección de Task 2; si `ventas_pos` no tiene `updated_at`, usar `created_at` o agregar trigger `updated_at` en una migración chica (decisión a anotar). Confirmar que el upsert respeta RLS (la sesión de supabase-js lleva el JWT del usuario logueado).
- [ ] **Step 5: Commit** — `git add packages/comanda/src/spike-offline/db.ts packages/comanda/src/spike-offline/replication.ts packages/comanda/package.json pnpm-lock.yaml && git commit -m "spike(offline): RxDB local + replicacion Supabase (pull/push)"`

---

## Task 4: El flujo + UI + test offline

**Files:**
- Create: `packages/comanda/src/spike-offline/flow.ts`
- Create: `packages/comanda/src/spike-offline/flow.test.ts`
- Modify: `packages/comanda/src/spike-offline/SpikeOfflinePage.tsx`

- [ ] **Step 1: Operaciones contra el store local** (`flow.ts`) — instantáneas por construcción (escriben en RxDB, NO esperan red):

```ts
// packages/comanda/src/spike-offline/flow.ts
import type { SpikeDB } from './db';

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export async function abrirMesa(db: SpikeDB, localId: number, mesaId: string | null) {
  const id = uuid();
  await db.ventas.insert({ id, local_id: localId, mesa_id: mesaId, estado: 'abierta', total: 0, updated_at: now() });
  return id;
}

export async function agregarItem(db: SpikeDB, ventaId: string, item: { item_id: string; nombre: string; precio: number; curso: number }) {
  await db.items.insert({ id: uuid(), venta_id: ventaId, ...item, cantidad: 1, updated_at: now() });
  await recalcularTotal(db, ventaId);
}

export async function cobrar(db: SpikeDB, ventaId: string, medio: string, monto: number) {
  await db.pagos.insert({ id: uuid(), venta_id: ventaId, medio, monto, updated_at: now() });
  const venta = await db.ventas.findOne(ventaId).exec();
  await venta?.patch({ estado: 'cobrada', updated_at: now() });
}

async function recalcularTotal(db: SpikeDB, ventaId: string) {
  const items = await db.items.find({ selector: { venta_id: ventaId } }).exec();
  const total = items.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const venta = await db.ventas.findOne(ventaId).exec();
  await venta?.patch({ total, updated_at: now() });
}
```

- [ ] **Step 2: Test offline (vitest)** — valida que el flujo corre 100% sobre el store local SIN red (sin replicación), instantáneo y consistente. Escribir el test:

```ts
// packages/comanda/src/spike-offline/flow.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { crearSpikeDB } from './db';
import { abrirMesa, agregarItem, cobrar } from './flow';

describe('spike offline flow (local-only, sin red)', () => {
  let db: Awaited<ReturnType<typeof crearSpikeDB>> | null = null;
  afterEach(async () => { await db?.remove(); db = null; });

  it('abrir → agregar → cobrar funciona sobre el store local', async () => {
    db = await crearSpikeDB();
    const ventaId = await abrirMesa(db, 2, 'mesa-1');
    await agregarItem(db, ventaId, { item_id: 'i1', nombre: 'Roll Avocado', precio: 5000, curso: 1 });
    await agregarItem(db, ventaId, { item_id: 'i2', nombre: 'Roll Salmon', precio: 7000, curso: 1 });
    const venta = await db.ventas.findOne(ventaId).exec();
    expect(venta?.total).toBe(12000);
    await cobrar(db, ventaId, 'efectivo', 12000);
    const cobrada = await db.ventas.findOne(ventaId).exec();
    expect(cobrada?.estado).toBe('cobrada');
    const pagos = await db.pagos.find({ selector: { venta_id: ventaId } }).exec();
    expect(pagos.length).toBe(1);
  });
});
```

- [ ] **Step 3: Correr el test** — `pnpm --filter comanda test -- src/spike-offline/flow.test.ts` → PASS (prueba que el flujo es local-only e instantáneo; si RxDB no estuviera bien, falla acá). **OJO:** RxDB en Node usa `fake-indexeddb` o el storage memory para tests — si Dexie no corre en vitest, cambiar el storage del test a `getRxStorageMemory()` (`rxdb/plugins/storage-memory`).

- [ ] **Step 4: UI del spike** — reescribir `SpikeOfflinePage.tsx`: botones "Abrir mesa", "Agregar ítem", "Cobrar", que llaman al flujo; suscripción reactiva al store (`db.ventas.find().$`) que muestra el estado EN VIVO; un cartel con el estado de la replicación. Mostrar también un recordatorio de cómo probar offline (DevTools → Network → Offline) y la checklist de los 6 criterios. (Código completo: ~80 líneas de React básico usando los helpers de `flow.ts` + `crearSpikeDB`/`startReplication`; armarlo siguiendo el patrón de cualquier page de COMANDA.)

- [ ] **Step 5: Commit** — `git add packages/comanda/src/spike-offline/flow.ts packages/comanda/src/spike-offline/flow.test.ts packages/comanda/src/spike-offline/SpikeOfflinePage.tsx && git commit -m "spike(offline): flujo abrir/agregar/cobrar local + test offline + UI"`

---

## Task 5: Validar los 6 criterios con RxDB (+ evaluación PowerSync si hay instancia)

**Files:** (sin código nuevo — es medición; notas → el informe de Task 6)

- [ ] **Step 1: Validar a mano en `localhost:5174/pos/_spike-offline`** (con la sesión logueada para que el JWT vaya en las queries):
  1. **Instantáneo:** tocar "Agregar ítem" repetido → la pantalla actualiza sin esperar (medir con DevTools Performance que el repaint sea < 100 ms y que NO haya request en el camino del toque).
  2. **Offline real:** DevTools → Network → Offline → correr abrir→agregar→cobrar completo → funciona.
  3. **Sobrevive recarga:** con la red OFF, recargar la página (F5) → el estado local sigue ahí y se puede seguir operando.
  4. **Reconcilia sin duplicados:** volver la red ON → ver que los cambios suben (chequear en Supabase que aparecen las filas, una sola vez) y que re-disparar el sync no duplica.
  5. **RLS / multi-tenant:** confirmar que solo trae/sube filas del local/tenant logueado (probar que no leakea otro local).
  6. **Costo/operación RxDB:** $0 (corre client-side, sin servicio extra). Anotar fricciones (impedancia relacional, tamaño del plugin, DX).

- [ ] **Step 2 (requiere instancia PowerSync — si no está, marcar BLOQUEADO y seguir):** repetir una evaluación equivalente con PowerSync. Instalar `@powersync/web` + conector Supabase, sincronizar las 3 tablas, correr el mismo flujo, y anotar los mismos 6 criterios + DX + costo real del plan. Si la instancia no está lista, hacer evaluación de escritorio (docs/costo/fit) y dejar la práctica para cuando Lucas la cree.

- [ ] **Step 3:** consolidar las mediciones (tabla de 6 criterios × motor) para el informe.

---

## Task 6: Informe de decisión (entregable)

**Files:**
- Create: `docs/superpowers/2026-06-18-comanda-offline-spike-resultado.md`

- [ ] **Step 1: Escribir el informe** con: (a) tabla de los 6 criterios × {RxDB, PowerSync}; (b) recomendación de motor con evidencia; (c) el **patrón validado** (cómo se lee/escribe/sincroniza una entidad) que las Fases 1-2 replicarán; (d) la columna de checkpoint que se usó (`updated_at`) y si hizo falta tocar el schema; (e) riesgos/sorpresas; (f) go/no-go. Si ningún motor pasa, decirlo y proponer plan B.
- [ ] **Step 2: Commit** — `git add docs/superpowers/2026-06-18-comanda-offline-spike-resultado.md && git commit -m "docs(comanda): resultado del spike offline (decision de motor)"`

---

## Task 7: Cierre
- [ ] **Step 1:** `pnpm --filter comanda typecheck` + `lint` OK; el test del spike verde. Push a main; verificar deploy COMANDA READY (la ruta es dev-only, no afecta prod). 
- [ ] **Step 2:** Actualizar memoria: resultado del spike + motor elegido en `project_comanda_offline_decision_18_jun.md`; marcar Fase 0 hecha en pendientes; anotar que sigue la **Fase 1** (migrar flujo central) con su propia spec→plan.
- [ ] **Step 3:** Decidir con Lucas: ¿el sandbox del spike se mantiene como base de la Fase 1, o se borra y se arranca limpio? (Default: mantener el patrón validado, borrar la UI throwaway.)

---

## Self-review notes
- **Cobertura de la spec:** flujo abrir→agregar→cobrar ✅ (T3-4), aislado/gateado ✅ (T1), local de prueba ✅ (T4/T5 usan local 2), 6 criterios ✅ (T5), informe go/no-go + patrón ✅ (T6), fuera-de-alcance respetado (no migra pantallas, no PWA, no borra viejo) ✅.
- **Desvío vs spec:** la spec decía "PowerSync primero"; el plan **arranca con RxDB** porque PowerSync necesita instancia externa de Lucas (RxDB desbloquea el build ya). Ambos se evalúan igual (T5). Es un orden pragmático, no cambia el objetivo.
- **Naturaleza spike:** los pasos de UI (T4 S4) y validación (T5) son "construir y medir", no TDD — es correcto para un spike; el único test automatizado es `flow.test.ts` (prueba que el flujo es local-only/instantáneo).
- **Placeholders:** el código determinístico está completo; lo explícitamente "a ajustar en ejecución" es el subset de columnas (depende de la introspección T2) y la UI de T4-S4 (React básico) — señalado, no oculto.
- **Riesgo:** RxDB+Supabase usa replicación con handlers propios (no plugin oficial) — si resulta más frágil de lo esperado, el spike lo revela y PowerSync (con soporte Supabase oficial) pasa a favorito; ese es justamente el punto del spike.
