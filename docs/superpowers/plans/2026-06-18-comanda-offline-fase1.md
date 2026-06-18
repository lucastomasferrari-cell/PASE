# COMANDA Offline Rebuild — Fase 1 (Flujo central) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (o subagent-driven-development) task-by-task. Steps usan checkbox `- [ ]`. **Contexto que baja el riesgo: COMANDA está en CERO — sin clientes, sin data real (la data de ventas_pos es de prueba).** Por eso se migra de una, sin flag-incrementalismo ultra-cauto. OJO igual: la DB es compartida con PASE (producción real) → migraciones SQL solo aditivas + verificadas.

**Goal:** Migrar el flujo central de COMANDA (abrir mesa → agregar ítem → cobrar) al motor local-first **RxDB**, con **UI optimista** (lee/escribe el store local, instantáneo) y **push vía las RPCs `_offline`** (no upsert crudo — confirmado necesario por el spike), reemplazando el sistema offline artesanal actual para ese flujo.

**Architecture:** Módulo nuevo `src/lib/offline2/` (provider/singleton + store RxDB + pull de tablas + push que invoca las RPCs `_offline`). Los servicios del flujo central (`ventasService`/`pagosService`/`mesasService`/`pedidosService`) leen/escriben el store local; el push sincroniza con Supabase llamando a las RPCs atómicas (que computan `numero_local`/`modo`/resuelven uuid→id). El sistema viejo (`lib/sync/*`, `services/offline/*`) queda en paralelo y se borra en Fase 2.

**Tech Stack:** React 19 + Vite 8 + RxDB 17 (Dexie) + Supabase. vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-18-comanda-offline-rebuild-design.md`. **Spike validado:** `docs/superpowers/2026-06-18-comanda-offline-spike-resultado.md` (criterios 1-3 OK; patrón en `src/spike-offline/`). **Decisión:** RxDB (validado, $0).

**Hallazgos del spike que este plan implementa:** (1) identidad por `idempotency_uuid`; (2) `ventas_pos_pagos.venta_idempotency_uuid` YA agregada (migración `202606181400`); (3) **push vía RPCs `_offline`** (numero_local/modo/canal_id/idempotency_key son NOT NULL que solo las RPCs llenan); (4) **motor inicializado UNA vez (provider/singleton)** o cuelga en StrictMode.

---

## File Structure
- **Create** `src/lib/offline2/schema.ts` — schemas RxDB de producción (ventas_pos, items, pagos, + mesas e items-catálogo para lectura offline). Basado en `spike-offline/schema.ts`.
- **Create** `src/lib/offline2/db.ts` — RxDatabase singleton (patrón validado del spike).
- **Create** `src/lib/offline2/OfflineProvider.tsx` — React context: crea la DB UNA vez, arranca el sync, expone `useOfflineDb()` + estado del sync. Resuelve StrictMode.
- **Create** `src/lib/offline2/pull.ts` — pull incremental por `updated_at` de las tablas que el POS lee (validado en spike).
- **Create** `src/lib/offline2/push.ts` — **push que invoca las RPCs `_offline`** (NO upsert). Pieza nueva clave.
- **Create** `src/lib/offline2/repos.ts` — operaciones locales optimistas (abrir/agregar/cobrar) sobre el store + encolan el push.
- **Modify** `src/services/ventasService.ts`, `pagosService.ts`, `mesasService.ts`, `pedidosService.ts` — rama que usa `offline2` cuando el flag está ON.
- **Modify** migración RPC: `fn_agregar_pago_venta_comanda_offline` (y `fn_abrir_venta_comanda_offline` si hace falta) para aceptar/guardar `venta_idempotency_uuid` del pago.
- **Modify** `src/App.tsx` — envolver con `<OfflineProvider>` cuando el flag está ON.
- **Tests:** `src/lib/offline2/*.test.ts` (flujo local + mapeo push→RPC) + e2e mutante del ciclo offline→sync.

---

## Task 1: Promover el store del spike a `lib/offline2` (schema + db + provider)

**Files:** Create `src/lib/offline2/schema.ts`, `db.ts`, `OfflineProvider.tsx`

- [ ] **Step 1:** Copiar `schema.ts` y `db.ts` del spike a `src/lib/offline2/` (ya validados). Mantener PK `idempotency_uuid`, el singleton por nombre (`crearOfflineDB`), storage Dexie.
- [ ] **Step 2:** Escribir `OfflineProvider.tsx` — un React context que crea la DB **una sola vez** (vía el singleton) y la expone con `useOfflineDb()`. Esto resuelve el StrictMode a nivel app (no por componente).

```tsx
// src/lib/offline2/OfflineProvider.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { crearOfflineDB, type OfflineDB } from './db';
import { startSync } from './push'; // re-export que arranca pull+push

const Ctx = createContext<OfflineDB | null>(null);
export const useOfflineDb = () => useContext(Ctx);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<OfflineDB | null>(null);
  useEffect(() => {
    let stop: (() => void) | null = null;
    crearOfflineDB().then((d) => { setDb(d); stop = startSync(d); });
    return () => { stop?.(); };
  }, []);
  return <Ctx.Provider value={db}>{children}</Ctx.Provider>;
}
```

- [ ] **Step 3:** `pnpm --filter comanda typecheck`. **Step 4: Commit** — `feat(comanda offline2): store RxDB de produccion + provider singleton`.

## Task 2: Pull incremental (`pull.ts`)
- [ ] **Step 1:** Portar `replication.ts` del spike → `pull.ts`, dejando SOLO el pull (las 3 tablas + agregar `mesas` e `items` catálogo para que el POS lea offline). Filtra por `updated_at` + `idempotency_uuid not null` + RLS del JWT.
- [ ] **Step 2:** typecheck. **Commit** — `feat(comanda offline2): pull incremental de Supabase`.

## Task 3: Push vía RPCs `_offline` (`push.ts`) — pieza clave

**Files:** Create `src/lib/offline2/push.ts`

- [ ] **Step 1:** Implementar el push con `replicateRxCollection`, pero el `push.handler` **llama a las RPCs `_offline`** en vez de upsert. Mapa entidad→RPC: venta nueva → `fn_abrir_venta_comanda_offline`; ítem → `fn_agregar_item_comanda_offline`; pago → `fn_agregar_pago_venta_comanda_offline`. Resolver el padre por uuid antes (las RPCs ya lo hacen con `fn_resolver_venta_id_por_uuid`). **OJO durante ejecución:** confirmar las firmas EXACTAS de cada RPC `_offline` (introspección como en el spike) y mapear los campos del doc local a los params. El resultado de la RPC trae el `id` bigint → escribirlo de vuelta en el doc local (cierra el ciclo uuid→id).
- [ ] **Step 2:** `startSync(db)` = arranca pull (Task 2) + push, devuelve un `stop()`.
- [ ] **Step 3:** typecheck. **Commit** — `feat(comanda offline2): push via RPCs _offline (no upsert crudo)`.

## Task 4: RPC de pago acepta `venta_idempotency_uuid`

**Files:** Create migración `packages/pase/supabase/migrations/2026061815xx_pago_offline_venta_uuid.sql`

- [ ] **Step 1:** `CREATE OR REPLACE` de `fn_agregar_pago_venta_comanda_offline` para aceptar `p_venta_idempotency_uuid uuid` y guardarlo en la columna nueva (+ resolver venta_id por ese uuid si la venta ya existe). Mantener firma idempotente, REVOKE anon. **OJO:** leer la firma actual primero (migración `202606130600`).
- [ ] **Step 2:** Aplicar + verificar (flujo oficial pg). **Commit** — `feat(comanda offline): pago offline guarda venta_idempotency_uuid`.

## Task 5: Operaciones locales optimistas (`repos.ts`)
- [ ] **Step 1:** Portar `flow.ts` del spike → `repos.ts`: `abrirMesa`/`agregarItem`/`cobrar` (+ las que falten del flujo central) escriben el store local al instante. El push (Task 3) sincroniza solo.
- [ ] **Step 2:** Test unitario (como `spike-offline/flow.test.ts`, storage memory). **Commit** — `feat(comanda offline2): operaciones locales optimistas + test`.

## Task 6: Wirear el flujo central a `offline2`

**Files:** Modify `ventasService.ts`, `pagosService.ts`, `mesasService.ts`, `pedidosService.ts`, `App.tsx`

- [ ] **Step 1:** Envolver el árbol del POS con `<OfflineProvider>` en `App.tsx` cuando `featureFlags.offlineFirstVentas` está ON.
- [ ] **Step 2:** En cada service del flujo central, cuando el flag está ON, **leer/escribir vía `offline2`** (las repos/store) en vez de Supabase directo. Las pantallas (`VentaScreen`/`PedidoDetalle`/`SalonView`) ya consumen estos services → quedan optimistas sin tocarlas (o con ajustes mínimos de suscripción reactiva).
- [ ] **Step 3:** typecheck + lint + build. **Commit** — `feat(comanda offline2): wirear flujo central (ventas/mesas/pagos) al store local`.

## Task 7: Test E2E mutante del ciclo offline→sync
- [ ] **Step 1:** Mutante: abrir→agregar→cobrar local (sin red) → arrancar sync → verificar que las RPCs `_offline` crearon venta+items+pago en Supabase (Local Prueba 2), con el `id` bigint resuelto y SIN duplicados (re-sync no duplica). Cleanup.
- [ ] **Step 2:** Correr verde. **Commit** — `test(comanda offline2): ciclo offline→sync via RPCs`.

## Task 8: Cierre Fase 1
- [ ] typecheck + lint + build + tests verdes. Push; deploy COMANDA READY. Prender el flag y smoke. Actualizar memoria. Dejar anotada la **Fase 2** (overrides/transferir/partir/mermas + PWA + **borrar `lib/sync/*` y `services/offline/*`** viejos).

---

## Self-review
- **Cobertura spec:** motor RxDB ✅ (T1-2), UI optimista por store local ✅ (T5-6), push vía RPCs ✅ (T3 — el hallazgo central), pagos uuid ✅ (T4 + migración 202606181400 ya aplicada), provider singleton ✅ (T1), tests ✅ (T5,T7). Fuera de Fase 1 (→ Fase 2): overrides/transfer/partir, PWA, borrar el sistema viejo, mermas/KDS.
- **Naturaleza:** varios pasos son "portar lo validado del spike" (bajo riesgo) + 1 pieza nueva real (push→RPC, T3) que requiere introspección de firmas en ejecución (señalado).
- **Riesgo:** el mapeo doc→params de cada RPC `_offline` es el trabajo fino; por eso T3 dice introspeccionar firmas exactas antes (mismo método que funcionó en el spike). Migraciones solo aditivas (DB compartida con PASE).
