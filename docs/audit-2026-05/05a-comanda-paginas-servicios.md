# Fase 5A — COMANDA: páginas y servicios

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Scope:** `packages/comanda/src/pages/**/*.tsx` (90+ archivos), `packages/comanda/src/services/*.ts` (49 archivos prod + 19 test), `packages/comanda/src/lib/sync/*` (8 archivos), `packages/comanda/src/lib/db/*` (4 archivos + repositories), `packages/comanda/src/lib/AuthPosProvider.tsx`, `PinGate.tsx`, `PWAUpdatePrompt.tsx`.
**Método:** lectura completa de los 5 archivos > 500 LOC, lectura dirigida de Caja, KDS, Salón, Mostrador, Handheld, Pedidos, dialogs críticos (PaymentDialog, ManagerOverride). Greps por TODO/FIXME, `as any`, `console.log`, `type="date"`, `toISOString().slice(0,10)`, `db.from(` en services, conteo de hooks.

---

## 📊 Resumen ejecutivo

| Métrica | Valor | Comentario |
|---|---|---|
| Pages totales (.tsx) | **90+** | top 5: VentaScreen (1378), HandheldView (725), IntegracionPartner (707), SettingsLocal (652), TiendaCheckout (627). |
| Services prod | **49** | `.test.ts` paralelos: 19 (38% coverage de archivos). |
| Hooks propios (`lib/use*.ts`) | **8** + 2 en `hooks/` | useDebouncedValue, useFeaturesPosModos, useGeolocation, useGuardedHandler, useNotifier, useOnlineStatus, usePermiso, useRealtimeTable, useVisiblePolling, useTimezone, useTheme, useToast. |
| Sync engine | **completo Fase 4.3** | syncEngine + operations + push/pull (initial+incremental) + idReconciliation + conflictResolver (LWW). **Detrás de feature flag `offlineFirstVentas`** — no activo por defecto. |
| IndexedDB stores | **11** | items, item_grupos, mesas, canales, empleados, ventas_pos, ventas_pos_items, ventas_pos_pagos, sync_meta, pending_ops, sync_conflicts. DB_VERSION=1 (sola migration). |
| `TODO`/`FIXME` reales en código | **3** | AjusteStockDialog:69 (manager PIN pendiente), mesasService:192 (refactor tenant+local), printerService:207 (endpoint open-drawer pendiente). |
| `: any` / `as any` | **0** | Excelente — TS strict respetado. Hay `unknown` (90+) y `as unknown as X` (varios) — más laxo pero acotado. |
| `console.log` en código de prod | **35** ocurrencias en 20 archivos | Mezcla de legítimos (PWA register, error boundaries, sync engine debug) + ruido en services (printer/auth/payment). |
| `db.from(...)` desde services (lectura cruda sin RPC) | **86 calls en 39 services** | OK para SELECTs; pero `gruposService`, `canalesService`, `itemsService`, `cuponesService`, `combosService`, `localSettingsService`, `comanda_local_settings` hacen `.insert/.update/.delete` directos. No tocan tablas financieras — pero saltean el patrón "service encapsula RPC". |
| Inputs `type="date"` | **10 ocurrencias en 5 archivos** | CajaChica, ConciliacionMpView, ReporteCMV, ReportesLayout, SettingsAuditoria + Tienda. **Todos construyen `new Date(desde+'T00:00:00').toISOString()`** → bug TZ idéntico al de PASE Fase 4. |
| useState en VentaScreen.tsx | **23 useState** + 14 useEffect + 5 useMemo + 2 useCallback en una sola página | God-component. La regla de extracción no se aplicó cuando pasó los 800 LOC. |
| Datepicker respeta TZ | **NO** | Mismo bug que F4 PASE — ver hallazgo #6. |
| Floats en money | **Sí (number JS)** | `monto * cantidad` directo, `0.01` comparators, `propinaIncl = Math.min(...)`. Sin helper money. |
| Forms sin validation | Parcial | Algunos confían en disabled+min/max del HTML; varios dialogs validan inline (PaymentDialog ok). |
| PWA update prompt | **OK** | `PWAUpdatePrompt.tsx` usa `useRegisterSW` con toast persistente — buen patrón. SW versionado por VitePWA. |
| Auth POS auto-lock | **3 min default** (configurable `autolockMin`) | Borra sessionStorage + reset state. Sin warning previo al usuario. |
| Test coverage cualitativo | **bajo en pages** | 0 tests `.test.tsx` para pages. Hay tests de services (19 archivos) + sync (2 tests). |

---

## 🚦 Tabla ranking por severidad

| # | Hallazgo | Archivo:línea | Severidad |
|---|---|---|---|
| 1 | **Sync engine NUNCA se monta** — `syncEngine.start()` requiere `featureFlags.offlineFirstVentas`, pero las funciones `abrirVenta`/`agregarItem` ya pasan por el branch offline cuando el flag está ON. Si alguien activa el flag sin que `SyncEngineLifecycle` esté en `App.tsx`, las ops se encolan en IndexedDB y NUNCA salen al cloud (queda data offline ghost) | `lib/sync/SyncEngineLifecycle.tsx`, `services/ventasService.ts:90` | 🔴 CRÍTICO si se activa flag |
| 2 | **Doble `setLastPullAt` race-condition con cambio de localActivo** — `pullVentasItemsIncremental` no filtra por `local_id` (línea 234: `supabase.from('ventas_pos_items').select('*')` confiando en RLS). Si el usuario cambia de local, el cursor `updated_at > since` puede traer items del local nuevo, pisar locales del anterior, y marcar `last_pull_at` del scope nuevo con un cursor del viejo | `lib/sync/pullIncremental.ts:233-234` | 🔴 ALTO |
| 3 | **Idempotency key débil basado en ventana 5s** — `anularItem`/`cortesiaItem`/`modificarPrecioItem` en VentaScreen usan `Math.floor(Date.now()/5000)`. Si el manager hace doble-click pero cruza el límite de ventana (i.e. tap a t=4998ms y t=5001ms), la RPC ejecuta DOS veces. Documentado como "previene doble-click" pero no garantiza idempotency real | `pages/Pos/VentaScreen.tsx:871, 888, 950, 1021` | 🔴 ALTO |
| 4 | **Reset de `_tempIdCounter` se pierde al refresh** — `let _tempIdCounter = -1_000_000_000` en `ventasOfflineService.ts`. Si dos sesiones del mismo browser/tab generan tempIds en paralelo (e.g. tras refresh), pueden colisionar. Solución correcta: persistir el counter o derivar de `crypto.randomUUID()` | `services/offline/ventasOfflineService.ts:27` | 🔴 ALTO |
| 5 | **VentaScreen.tsx es god-object (1378 LOC, 23 useState)** — toda la lógica de catálogo + check + dialogs + 5 ManagerOverrides + historial + reconciliation listener en un solo archivo. Las funciones `addItem`, `repetirItem`, `removeItem`, `clickItem`, `longPressItem`, `onToggleFavorito`, `changeQty`, `mandarCursoHandler`, `mandarItemSolo`, `toggleStay`, `guardarNotasVenta`, `toggleCoursingAuto` se re-crean en cada render (NO usan `useCallback`). En una mesa con 30 items y catálogo de 200, cada `setItems` re-renderea todos los `ProductTile` y `CheckRow` (NO memoizados) | `pages/Pos/VentaScreen.tsx:307-476` | 🟠 ALTO |
| 6 | **Datepicker no respeta TZ Argentina** (bug F4 PASE replicado) — `new Date(desde+'T00:00:00').toISOString()` interpreta `desde` como hora LOCAL del browser, convierte a UTC. En AR (UTC-3) "2026-05-27" se manda como `2026-05-27T03:00:00Z`. Funciona en AR; **se rompe si el cajero opera desde otro huso**. Los reportes/dashboards/CMV usarán fechas erróneas | `pages/Caja/CajaChica.tsx:65-66`, `Caja/ConciliacionMpView.tsx:49-50`, `Reportes/ReporteCMV.tsx:52-57,81`, `Reportes/ReportesLayout.tsx:58-66`, `Settings/SettingsAuditoria.tsx:130-134` | 🟠 ALTO |
| 7 | **PaymentDialog: cobro multipago no es atómico, hay riesgo de inconsistencia** — el loop `for (const p of pagosAEnviar) { agregarPago(...) }` ejecuta N RPCs secuenciales. Si la 2ª falla, la 1ª ya quedó committed en server. El cajero ve "Error procesando pago" sin saber que el primer pago se acreditó. Solución: una sola RPC `fn_cobrar_venta_multipago(p_pagos[])` atómica | `components/dialogs/PaymentDialog.tsx:151-172` | 🟠 ALTO |
| 8 | **Conflict resolver LWW: localeCompare con `updated_at` strings, no parsing** — `resolveLWW` usa `new Date(local.updated_at).getTime()` OK, **pero** `listPendingOps` ordena con `a.created_at.localeCompare(b.created_at)`. Funciona para ISO 8601 estable, pero si dos ops se crean en el mismo ms (FIFO en cola, agregadas con `for` rápido), el orden es indeterminado. Items del mismo curso pueden encolarse fuera de orden de inserción → cocina ve cantidades erróneas | `lib/sync/operations.ts:75`, `lib/sync/conflictResolver.ts:65-66` | 🟠 ALTO |
| 9 | **MAX_RETRIES=5 + cleanup 7d → ops failed huérfanas tras logout** — si una op llega a `failed`, queda en pending_ops indefinidamente (cleanup solo borra `synced`). Sin UI de "Operaciones rotas" implementada → el empleado loguea de nuevo y arrastra ops viejas que ya fueron ejecutadas vía otro device. NO hay forma desde la UI de descartar manualmente | `lib/sync/operations.ts:118, 153-165` | 🟠 ALTO |
| 10 | **AuthPosProvider auto-lock sin warning** — `setTimeout` de 3 min × 60_000ms, al cumplirse borra sessionStorage y empuja a PinPad. Si el mozo está mid-cobro (PaymentDialog abierto con pagos parciales), pierde el estado del dialog completo. Sin `prompt-2min` warning previo, sin "extender sesión" | `lib/AuthPosProvider.tsx:35-42` | 🟠 ALTO |
| 11 | **Optimistic update del total en `agregarItemOffline` sin validación** — línea 200-201 hace `venta.subtotal = Number(venta.subtotal) + subtotal; venta.total = Number(venta.total) + subtotal`. NO aplica descuentos, NO aplica modificadores en el subtotal (subtotal calculado en línea 164 ya los ignora). Cuando el server responde con total real, hay flicker y posible inconsistencia con UI activa | `services/offline/ventasOfflineService.ts:164, 200-201` | 🟠 ALTO |
| 12 | **`reload` callbacks en VentaScreen son alias inconsistentes** — `const reload = reloadVenta` (línea 145). Pero `addItem` después de Sprint optim egress llama `reload()` (el light), no `reloadFull()`. Si el cajero agregó un item NUEVO (ej. agotó stock vía RPC desde KDS) en otro device, no aparece hasta que recargue catálogo. Esa función ya no se llama desde `addItem` después del cambio | `pages/Pos/VentaScreen.tsx:106, 130, 145, 319, 350, 366` | 🟡 MEDIO |
| 13 | **86 calls `db.from(...)` desde services con `.insert/.update/.delete` directos en tablas no-financieras** — `gruposService`, `canalesService`, `itemsService`, `cuponesService`, `combosService`, `localSettingsService`, `metodos_cobro`, `comanda_local_settings`, `kds_tokens`, `mapeos_locales_externos`. RLS los cubre, pero no hay servidor-side validation extra (uniqueness, business rules). Mezcla de patrones: financieras → RPC, masters → INSERT crudo | `services/canalesService.ts:44-55`, `services/gruposService.ts:45-66`, `services/itemsService.ts:122-138` y otros | 🟡 MEDIO |
| 14 | **`useEffect` en CajaCerrar carga datos sin cancellation flag** — línea 39-53 hace IIFE async sin cleanup. Si el localId cambia rápido (encargado con 2+ locales), puede setState sobre desmontado. Bug menor: setLoading(false) final puede ejecutarse después de unmount | `pages/Caja/CajaCerrar.tsx:39-53` | 🟡 MEDIO |
| 15 | **KdsView: `Promise.all` para "Listo todo" no es atómico** — handler `handleListoTodo` dispara N `marcarListo` en paralelo. Si el cocinero clickea durante una desconexión, algunos OK + algunos error → estado mixto. Sin recovery automático | `pages/Kds/KdsView.tsx:168-179` | 🟡 MEDIO |
| 16 | **PinGate no chequea expiración del PIN ni rate-limit en cliente** — el dialog PinPad llama `verificarPin` por cada input. NO hay throttling client-side; un atacante con acceso al device puede brute-force 9999 PINs (la RPC presumiblemente tiene rate limit server, pero está fuera de scope visto) | `components/PinGate.tsx`, `lib/AuthPosProvider.tsx:60-78` | 🟡 MEDIO |
| 17 | **DB_VERSION=1, sin migrations subsiguientes ni mecanismo de purga de data vieja** — items pulleados crecen indefinidamente (sin `tenant_id` change cleanup); `pending_ops` con status='synced' cleanup manual a 7d via `cleanupOldSynced` pero NUNCA se llama. `sync_conflicts` también crece sin límite | `lib/db/schema.ts:25`, `lib/sync/operations.ts:153-165` | 🟡 MEDIO |
| 18 | **`prevAprobacionCountRef` se reinicia en cada `reloadFull` que se ejecuta al cambiar tab** — useEffect:80 cambia search/canalFiltro en tab change, pero `prevAprobacionCountRef` es ref persistente. Si el manager rota tabs rápido, el delta de notificaciones se calcula contra el counter de cualquier tab anterior, no del tab actual. Falsos positivos de "🛵 X pedidos nuevos por aprobar" cuando solo cambió la vista | `pages/Pos/PedidosHub.tsx:71, 105-114, 133-142` | 🟡 MEDIO |
| 19 | **35 console.log en código de prod** — sync engine intencionales para debug ("[pushQueue] reconciliación falló", "[PWA] SW registrado"), pero PaymentDialog:201 `console.warn('[print ticket] falló…')`, sync engine console.log de eventos, etc. Sin sink central para soporte; no se ven en producción | (múltiples) | 🟡 MEDIO |
| 20 | **`featureFlags.offlineFirstVentas` dispatch dinámico desde services** — `ventasService.ts:89, 220, 288, 415` hace `await import('../lib/featureFlags')` en cada call. Promesa por call al feature flag de un módulo síncrono. Costo perf bajo, pero indicador de arquitectura tentativa | `services/ventasService.ts:89-117` | 🟡 MEDIO |
| 21 | **`abrirVentaOffline` pasa `tenantId: ''` cuando se llama desde `abrirVenta` con flag ON** — línea 100 de `ventasService.ts`. El comentario admite que el server lo derivará vía `auth_tenant_id()`, pero **el row local en IndexedDB queda con `tenant_id=""`**. Cualquier query local que filtre por tenant pierde la venta hasta el sync | `services/ventasService.ts:99-110` | 🟡 MEDIO |
| 22 | **`agregarItemOffline.subtotal` no incluye precio_extra de modificadores** — `subtotal = args.cantidad * args.precioUnitario`. Si el item tiene `modificadores: [{precio_extra: 500}]`, el subtotal LOCAL queda subestimado vs lo que calcula el server. UI offline muestra menos plata que la real hasta sync | `services/offline/ventasOfflineService.ts:164` | 🟡 MEDIO |
| 23 | **HandheldView: "mis-mesas" no filtra realmente por mozo** — comentario línea 154-163 admite que muestra "mesas con cualquier venta abierta" porque `MesaConVenta` no expone `mozo_id`. La pestaña es engañosa | `pages/Pos/HandheldView.tsx:154-163` | 🟢 BAJO |
| 24 | **CMV: período "anterior" calculado mal cuando `desde === hasta`** — ReporteCMV línea 70-77: `dHastaAnt.setDate(dHastaAnt.getDate() - 1)` luego `dDesdeAnt.setDate(dHastaAnt.getDate() - diasRango)` con `diasRango = max(1, ...)`. Si el usuario filtra un solo día, comparación devuelve rango de 2 días anterior, no de 1. Métrica "variación vs período anterior" inexacta | `pages/Reportes/ReporteCMV.tsx:70-77` | 🟢 BAJO |
| 25 | **`reload` en SalonView se llama desde useRealtimeTable callbacks sin debounce** — si dos cocineros marcan items listos en paralelo, dispara 2 `reload()` consecutivos. Realtime no garantiza dedup. Wireshark friendly: muchas queries idénticas | `pages/Pos/SalonView.tsx:59-60` | 🟢 BAJO |
| 26 | **`getTurnoAbierto` retorna primer turno sin chequear `cajero_id`** — `services/turnosCajaService.ts:5-14` no filtra por empleado actual. Si dos cajeros abren turnos paralelos (race condition en el día), un cajero ve el turno del otro. Probablemente cubierto por business rule "un turno por local", pero defensivo: filtrar también por sesión activa | `services/turnosCajaService.ts:5-14` | 🟢 BAJO |
| 27 | **`crypto.randomUUID?.()` fallback usa `Math.random()`** — `PaymentDialog:114, 137`, `pagosService:13-19`, `operations.ts:36-46`, `conflictResolver.ts:17-26`, `idReconciliation:38-46`, `ventasOfflineService:32-41`. Si el browser es viejo (sin `crypto.randomUUID`), las llaves de idempotency no son criptográficamente únicas — colisiones posibles bajo alta carga | (6 archivos) | 🟢 BAJO |
| 28 | **`AjusteStockDialog` muestra error como TODO** — `toast.error('Esta operación requiere validación de manager (TODO sprint próximo). Usá un ajuste tipo "Salida (otro)" como workaround temporal.')`. UX expone una promesa interna al usuario final | `components/dialogs/AjusteStockDialog.tsx:69-72` | 🟢 BAJO |

---

## 🔴 Detalle de findings críticos

### #1 — SyncEngineLifecycle puede no estar montado

**Riesgo:** si Lucas activa `featureFlags.offlineFirstVentas` sin verificar que `<SyncEngineLifecycle />` está en `App.tsx`, todas las operaciones de venta (abrir, agregar item, mandar curso) escriben en IndexedDB local y encolan ops, pero NADIE las procesa al cloud. El cajero VE su venta en pantalla (lectura local OK), el cocinero NO recibe el ticket en KDS porque pulea de server. Aparece como bug fantasma.

**Mitigación:**
```typescript
// services/ventasService.ts:117
if (featureFlags.offlineFirstVentas && !syncEngineMounted()) {
  throw new Error('Offline mode active pero syncEngine no inicializado');
}
```
o documentar en README al pie del flag.

---

### #2 — pullVentasItemsIncremental no filtra por local_id

```typescript
// lib/sync/pullIncremental.ts:233-234
async function pullVentasItemsIncremental(ctx: PullCtx): Promise<PullDelta> {
  ...
  // No filtramos por venta — confiamos en el RLS (que ya filtra por local).
  let q = supabase.from('ventas_pos_items').select('*');
  if (since) q = q.gt('updated_at', since);
```

El comentario admite que confía en RLS. Pero `setLastPullAt` usa `scope = ${tenantId}:${localId}`. Si el encargado cambia de local entre pulls, el cursor que se guarda es del local nuevo, pero los rows traídos pueden ser de cualquier local autorizado por RLS (`auth_locales_visibles()`). Próximo pull con cursor del local2 pierde deltas del local1.

**Fix:** agregar `.in('venta_id', listaVentasLocalActual)` o `.eq('local_id', ctx.localId)` (si la tabla lo expone).

---

### #3 — Idempotency basado en ventana de tiempo

```typescript
// pages/Pos/VentaScreen.tsx:871
const idKey = `anular-item-${anularItemTarget.id}-${Math.floor(Date.now() / 5000)}`;
const { error } = await anularItem(anularItemTarget.id, managerId, motivo, idKey);
```

El divisor `5000` agrupa requests cada 5 segundos. Si el manager confirma a `t=14998ms` y el browser late-clicks a `t=15003ms`, las dos llaves son `2` y `3` → no son iguales → la RPC ejecuta DOS veces (anula doble, pero en este caso el segundo da error porque ya está anulado — OK en este caso). El patrón es **frágil** para RPCs no-idempotentes server-side (ej. crear pago, mover plata). Verificar caso por caso.

**Fix:** generar UUID estable al primer click + reusarlo en retries (igual que `idempotencyKey` en `PaymentDialog`).

---

### #4 — Reset de _tempIdCounter al refresh

```typescript
// services/offline/ventasOfflineService.ts:27
let _tempIdCounter = -1_000_000_000;
function nextTempId(): number { return _tempIdCounter--; }
```

Es `let` a nivel de módulo. Al refresh del tab, el counter vuelve a `-1_000_000_000`. Si quedaron ventas locales con id `-1_000_000_000` no sincronizadas, el próximo `abrirVentaOffline` les pisa el id (`put` con misma key sobreescribe).

**Fix:**
```typescript
function nextTempId(): number {
  // Negativo + UUID-derived para garantizar unicidad cross-session
  return -Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}
```
o persistir el counter en `localStorage`.

---

### #5 — VentaScreen god-object: 23 useState + handlers sin memo

```typescript
// pages/Pos/VentaScreen.tsx (resumen)
const [venta, setVenta] = useState<VentaPos | null>(null);
const [items, setItems] = useState<VentaPosItem[]>([]);
const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
// ... (23 useStates totales — dialogs, lastAddedItemId, lastAddedRowId, modos,
// agotarItem, anularItemTarget, cortesiaItemTarget, precioItemTarget,
// precioNuevo, precioMotivo, showPrecioMgr, historialOpen, historial,
// editandoNotas, notasDraft, itemsConModifiers, pendingModifiers, cursoActivo,
// grupoSel, search, loading + dialog booleans)

// addItem se define sin useCallback (línea 307)
async function addItem(it, mods, notas, cantidad) { ... }
// Igual: repetirItem, removeItem, clickItem, longPressItem, changeQty,
// mandarCursoHandler, mandarItemSolo, toggleStay, guardarNotasVenta...

// ProductTile + CheckRow no son React.memo → re-render cascada en cada keystroke
```

Cada `setItems` (que llega vía Realtime + reloadVenta a ~30s) re-renderea los 200 ProductTile + los N CheckRow porque sus props (handlers) cambian referencia cada render. Las funciones se podrían `useCallback`-ear y los componentes hijos `React.memo`.

**Fix sugerido:** dividir en `<VentaScreenCatalogo>` + `<VentaScreenCheck>` + `<VentaScreenOverrides>` con context interno o props mínimas. Mover overrides (5 ManagerOverrideDialog) a un componente separado.

---

## 🟠 Detalle de findings ALTOS adicionales

### #6 — Datepicker no respeta TZ Argentina

Idéntico al bug de PASE F4 (`04a-paginas-grandes.md`). En `CajaChica.tsx:65-66`:
```typescript
const desdeIso = new Date(desde + 'T00:00:00').toISOString();
const hastaIso = new Date(hasta + 'T23:59:59').toISOString();
```
Si el browser corre en TZ != AR (turista, VPN, soporte remoto), `desde` se convierte a UTC asumiendo TZ local, los rangos quedan corridos. **Fix:** usar helper `toBuenosAires` o equivalente — el repo ya tiene `lib/useTimezone.ts`.

### #7 — Multipago no atómico
Ya documentado en tabla. Crítico para "$pagos múltiples": si la 2ª RPC falla (red caída, lock contention), la 1ª queda en server. La venta queda en estado parcialmente cobrada sin que el cajero lo sepa (el toast dice "Error procesando pago" sin saber cuáles).

### #8 — Conflict resolver localeCompare en created_at
Si dos ops se crean en el mismo `setTimeout` chain (e.g. `addItem` × 5 en `Promise.all`), `created_at` puede tener mismo timestamp ms → orden indeterminado. El test `lib/sync/__tests__/operations.test.ts` debería validar este caso.

### #9 — Failed ops sin UI de gestión
`pending_ops` con `status='failed'` quedan en IndexedDB para siempre. No hay pantalla "Operaciones rotas" que liste, permita reintentar manualmente, descartar. Si el empleado loguea de nuevo (`logout` borra sessionStorage pero NO IndexedDB), arrastra basura del turno anterior. **El comentario del código admite "requiere intervención manual" pero la UI no existe.**

### #10 — Auto-lock sin warning
3 min de inactividad y al PinPad. Sin pre-aviso. Si mid-cobro: pierde estado completo. Patrón normal en POS reales: "Sesión por expirar — 30s. [Continuar]". 

### #11 — Optimistic update offline sin modificadores
```typescript
// services/offline/ventasOfflineService.ts:164
const subtotal = args.cantidad * args.precioUnitario;
// venta.subtotal += subtotal; venta.total += subtotal;
```
Si el item tiene modificadores con `precio_extra`, el subtotal local subestima. Cuando sync responde, el server recalcula y el total cambia → mesa muestra cifra distinta a la que vio el cliente al pedir.

---

## 🟢 Notas positivas del diseño

- **TS strict respetado**: 0 `any` en todo el código (vs PASE que tenía algunos `as any`).
- **`useGuardedHandler`** + `useDebouncedValue` + `useVisiblePolling` muestran disciplina en patrones reutilizables.
- **PaymentDialog** tiene `confirmandoRef` (ref-based guard) anti-doble-click sincrónico — bien resuelto.
- **Cleanup con `cancelled`** flag en VentaScreen línea 203-214 (carga `itemsConModifiers`) muestra conciencia de unmount bugs.
- **`isBlocked` en pushQueue** para FK dependencies + `depends_on` chains: arquitectura sólida para offline-first.
- **LWW resolver tiene excepción** para `ventas.estado IN (cobrada, anulada)` → no se sobrescriben localmente. Buen criterio defensivo.
- **CMV / Reportes / SettingsAfip** son pantallas grandes pero bien delimitadas — no son god-components.
- **`useVisiblePolling`** pausa el polling cuando la pestaña está oculta — gran win egress (documentado #14 en F3C de PASE).
- **`SyncEngineLifecycle` desmonta limpio** en logout (línea 46-51 con `stopped` flag).

---

## 📌 Acciones recomendadas (prioridad)

1. **Antes de activar `offlineFirstVentas`:**
   - Validar que `<SyncEngineLifecycle />` está montado en `App.tsx`.
   - Implementar UI de "Operaciones rotas" para gestionar `pending_ops.failed`.
   - Migrar idempotency keys de ventana-de-tiempo a UUID estable.
   - Persistir `_tempIdCounter` en localStorage o usar UUID-derived.
   - Fix `pullVentasItemsIncremental` con `.eq('local_id', ctx.localId)`.

2. **Refactor VentaScreen.tsx:**
   - Extraer `<CatalogoColumn>`, `<CheckColumn>`, `<OverridesColumns>` a archivos separados.
   - `React.memo` en `ProductTile` y `CheckRow` (no cambian props vía Realtime).
   - `useCallback` en todos los handlers que cruzan a hijos memo'ed.
   - Apuntar a < 600 LOC en el archivo principal.

3. **Fix TZ datepickers:**
   - 5 archivos detectados (CajaChica, ConciliacionMpView, ReporteCMV, ReportesLayout, SettingsAuditoria).
   - Helper centralizado `fechaArgentinaToUTC(fechaStr: 'YYYY-MM-DD'): string`.

4. **Multipago atómico:**
   - Crear `fn_cobrar_venta_multipago_comanda(p_venta_id, p_pagos[], p_idempotency_key)` que itere server-side en una sola tx.
   - El cajero ve "todo OK" o "nada se aplicó" — sin estado mixto.

5. **Auto-lock con warning:**
   - 30s antes de lock, mostrar dialog "Tu sesión expira en 30s. [Seguir trabajando]".
   - Si PaymentDialog abierto, NO bloquear (pausa el timer).

6. **Cleanup periódico:**
   - Llamar `cleanupOldSynced()` al cerrar turno o al inicio del próximo turno.
   - Eliminar `sync_conflicts` resueltos > 30 días.
   - Logout debería borrar pending_ops del mismo empleado (o avisar "hay ops pendientes, querés descartarlas?").
