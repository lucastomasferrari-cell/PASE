# Fase 3 — Performance (consolidado)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Método:** 3 agentes en paralelo (F3A queries+índices · F3B bundle+frontend · F3C realtime+caches), código leído live del DB + grep masivo del monorepo + lectura del `dist/` post-build.

## 📊 Resumen ejecutivo

**71 findings totales** en 3 dominios. **15 críticos/altos accionables**.

Sub-reportes:
- [03a-queries-y-indices.md](./03a-queries-y-indices.md) — 15 findings (4 CR + 8 AL)
- [03b-bundle-y-frontend-perf.md](./03b-bundle-y-frontend-perf.md) — 10 findings (2 CR + 1 AL)
- [03c-realtime-y-caches.md](./03c-realtime-y-caches.md) — 15 findings (3 CR + 4 AL)

### ⚠️ Hallazgos confirmados con DATA REAL

1. **Realtime publication overinclusiva** — `SELECT wal->>...` del Realtime publisher quemó **26.1 millones de ms (~7h de CPU acumulada)** en el período medido por `pg_stat_statements`. 31× más caro que cualquier RPC productiva.
2. **Cron `fn_reactivar_items_vencidos` corrió 14.981 veces** (1×/min, 24×7) por solo 32 ítems en total — sin hits útiles el 99.9% de las veces.
3. **`mp_movimientos` recibió 150.986 UPDATEs** sobre 5.552 filas (27×/fila) — `/api/mp-process` re-escribe CSV cada sync sin chequear si cambió.
4. **`usuarios` con 19 filas tiene 48.8M seq_scans** — RLS helpers (`auth_es_dueno_o_admin`, `auth_locales_visibles`) leen `usuarios` en cada SELECT con local_id.
5. **COMANDA `index.js` 765 KB monolítico** — sin `manualChunks` en `vite.config.ts`. El user descarga + parsea 765 KB antes de ver nada.
6. **`routeWrappers.tsx` eager-importa 1.882 LOC de admin tabs** aunque el user nunca abra admin. Viola regla C8.
7. **Caja.tsx con saldos_caja abierto en POS rush** = 1 reload completo de 4 queries cada segundo.
8. **`useCategorias` + `useMediosCobro` + `usePuestosRRHH`** = 3 Supabase channels permanentes 24×7 por user para invalidar cache de tablas que cambian 1×/mes.

---

## 🎯 Ranking de los 15 críticos/altos accionables

| # | Bug | Sub | Sev | Esfuerzo | Impacto |
|---|---|---|---|---|---|
| 1 | Realtime publication tiene 49 tablas (incluye `usuarios`, `proveedores`, `config_categorias`, `tenants`) | F3A | 🔴 | 15 min | -30% WAL volume → -2h CPU/día |
| 2 | Cron `fn_reactivar_items_vencidos` corre cada minuto | F3A | 🔴 | 1 min | -92% invocaciones cron |
| 3 | COMANDA `index.js` 765 KB sin `manualChunks` | F3B | 🔴 | 15 min | -450 KB del inicial |
| 4 | COMANDA `routeWrappers.tsx` eager → lazy | F3B | 🔴 | 15 min | -60-80 KB del inicial |
| 5 | `Caja.tsx` saldos_caja+movimientos: reload completo en cada cambio | F3C | 🔴 | 1h | -90% reloads en POS rush |
| 6 | Falta índice `(local_id, cuenta) WHERE NOT anulado` en `movimientos` | F3A | 🟠 | 5 min | Trigger pasa de 0.47ms → <0.1ms |
| 7 | N+1 `Compras.tsx:520` aplicación multi-NC | F3A | 🟠 | 1h | 5 round-trips → 1 |
| 8 | N+1 `RRHHLegajo.tsx:780` anular N movimientos | F3A | 🟠 | 1h | N → 1 round-trip |
| 9 | `Caja.tsx:354` SELECT auditoria sin LIMIT ni filtro | F3A | 🟠 | 10 min | Browser no se cuelga al crecer audit |
| 10 | Falta índice `(estado, venc)` en `facturas` | F3A | 🟠 | 5 min | Bandeja vencidas baja a index scan |
| 11 | `mp-process.js` UPDATE sin `IS DISTINCT FROM` (27 updates/fila) | F3A | 🟠 | 15 min | -80% UPDATEs en mp_movimientos |
| 12 | `useBandejaEntrada` dispara 6 queries por INSERT a 3 tablas | F3C | 🔴 | 2h | -83% queries del topbar |
| 13 | `useCategorias`/`useMediosCobro`/`usePuestosRRHH` Realtime 24×7 | F3C | 🟠 | 1h | -3 channels permanentes por user |
| 14 | COMANDA sync engine `setInterval(30s)` sin pause-on-hidden | F3C | 🟠 | 30 min | -100% polling pestaña oculta |
| 15 | 6 índices dead (idx_scan=0) en mp_movimientos/movimientos/items/ig_mensajes | F3A | 🟡 | 1 min | -~500 KB + menos write overhead |

### Decisiones pendientes (requieren tu input)

- Cache `pg_timezone_names` en JS const (731ms × 793 calls — 10 min CPU acumulada). Es ~30 zonas Argentina, hardcodear.
- View `v_admin_metricas_tenants` → MATERIALIZED VIEW con refresh cada 1h. Cambia comportamiento del panel superadmin.
- Cron mensual de retention en `auditoria` (DELETE > 6 meses).

---

## Plan de ataque

**Migration `202605271000_audit_f3_criticos.sql`** que toca:
- F3A#1: ALTER PUBLICATION DROP TABLE para 38 tablas catálogo.
- F3A#2: cron.alter_job cron `fn_reactivar_items_vencidos` cada 15 min.
- F3A#6: CREATE INDEX `idx_movimientos_local_cuenta_activo` partial.
- F3A#10: CREATE INDEX `idx_facturas_estado_venc`.
- F3A#15: DROP 6 índices muertos.
- F3A#7: nueva RPC `aplicar_ncs_a_factura(p_ncs jsonb)`.
- F3A#8: nueva RPC `anular_movimientos_batch(p_ids jsonb)`.

**Edits TS:**
- F3A#9 `Caja.tsx`: `.limit(50)` + filtro fecha en auditoria
- F3A#11 `mp-process.js`: `IS DISTINCT FROM` antes de UPDATE
- F3A#7 `Compras.tsx:520`: 1 call a RPC consolidada
- F3A#8 `RRHHLegajo.tsx:780`: 1 call a RPC consolidada
- F3B#1 + F3B#3 `packages/comanda/vite.config.ts`: `manualChunks` + bajar `chunkSizeWarningLimit`
- F3B#2 `packages/comanda/src/App.tsx`: lazy del `routeWrappers`
- F3C#14 `packages/comanda/src/sync/syncEngine.ts`: pause-on-hidden

**Defer (requieren rediseño + decisión humana):**
- F3C#12 useBandejaEntrada consolidación a 1 RPC
- F3C#5 Caja.tsx unificar 2 hooks Realtime
- F3C#13 catálogos: on-focus invalidation + BroadcastChannel cross-tab

---

## Cross-fase observations

1. **Realtime es la palanca #1 de costo.** 7h CPU/día solo en publish. Reducir publication + reducir handlers que reloadean toda la tabla rinde más que cualquier índice individual.
2. **El patrón "hook que reload() en cada cambio"** está en TODOS los `useRealtimeTable` del monorepo. Es deuda arquitectónica — merge incremental del row recibido sería ideal pero requiere rediseño del hook.
3. **0 instancias de `React.memo`** en el monorepo. Components grandes (`CajaCardsRow`, `MovimientoRow`) re-renderizan en cada `load()` con props iguales.
4. **PASE bundle bien**, COMANDA al revés. Sintomático del "WIP que no terminó de aplicar las convenciones".
5. **PASE y COMANDA usan el mismo hook `useRealtimeTable` pero con código levemente distinto.** Buen candidato para `@pase/shared` cuando llegue el sprint del paquete shared.

## Para la próxima fase (F4)

F3 cerró performance. F4 (frontend PASE) puede arrancar en paralelo a los fixes auto-aplicables. Atacar:
- Páginas grandes monolíticas (Caja 1075, ConciliacionMP 1666, Compras 1204, RRHHLegajo 1253).
- Componentes que reciben demasiadas props.
- Dark mode coverage.
- Mobile responsiveness real (Lucas reportó 22-may bugs).
- Estados de error / empty / loading homogeneizados.
