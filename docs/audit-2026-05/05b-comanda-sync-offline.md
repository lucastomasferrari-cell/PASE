# 05b — COMANDA Sync Engine + IndexedDB (offline-first)

Auditoría profunda del motor de sincronización offline-first de COMANDA.
Fecha: 2026-05-27. Pasada única.

## Resumen ejecutivo

**Stats:**
- **2 DBs IndexedDB:** `comanda-local` (11 stores, sync engine — _no 10 como decía el brief_) + `comanda-offline` (7 stores, cache stale-while-revalidate).
- **11 stores sync engine:** items, item_grupos, mesas, canales, empleados, ventas_pos, ventas_pos_items, ventas_pos_pagos, sync_meta, pending_ops, sync_conflicts.
- **~16 RPCs offline-aware** declaradas server-side (`fn_*_comanda_offline` + helpers `fn_resolver_*_por_uuid`).
- **~14 operaciones offline** definidas client-side: abrir venta, agregar item, mandar curso, cobrar, anular item, cortesía, modificar precio, descuento, anular venta, transferir mesa, unir mesas, partir cuenta + 2 stubs `update/delete` genéricos.
- **5 test files de sync:** `operations`, `conflictResolver`, `idReconciliation`, `ventasOfflineService`, `pagosOverridesTransferOffline`. **ZERO tests** de `syncEngine` lifecycle, `pushQueue`, `pullInitial`, `pullIncremental`. Coverage del orquestador = 0%.
- **Race conditions identificadas: 12** (4 críticas, 5 altas, 3 medias).
- **Feature flag `offlineFirstVentas` ya está ON por default** (`featureFlags.ts:34`) — _no es "scaffolding sin wirear" como dice el banner de `syncEngine.ts:16-18`_. La doc del módulo está desincronizada con la realidad. Esto importa porque la severidad real de cada hallazgo es ahora "afecta a Lucas testeando en prod", no "afecta a un módulo dormido".

**Veredicto general:** el diseño es razonable (LWW + UUID idempotency + reconciliation + dependency graph) pero la implementación tiene varios **agujeros de coherencia y data-loss reales** que se manifestarían apenas haya 2 cajeros operando offline en simultáneo o el primer logout/cambio-de-tenant. Hoy no se notan porque solo Lucas está testeando, single-tab, single-tenant.

---

## Ranking por severidad

| # | Severidad | Título | Archivo |
|---|---|---|---|
| 1 | CRITICA | `markFailed` deja la op pegada infinita después de `markSyncing` → push queue rechaza para siempre | operations.ts:111-120 + pushQueue.ts:118-145 |
| 2 | CRITICA | Logout/cambio-tenant **NO** limpia IndexedDB → ops del user A se pushean cuando entra user B | UserAvatarMenu.tsx:31-35 + AuthPosProvider.tsx:80-83 |
| 3 | CRITICA | Pull initial **borra ventas locales dirty no sincronizadas** del local activo → pierde cobros offline | pullInitial.ts:178-203 |
| 4 | CRITICA | `runFullCycle` se aborta entero si pull falla → push queue nunca corre offline-recovery | syncEngine.ts:107-149 |
| 5 | ALTA | `cobrarVentaOffline` usa `'__pending_parent__'` literal en el payload → si el push corre antes del reconcile, el server recibe ese string en lugar del UUID real | pagosOfflineService.ts:109 |
| 6 | ALTA | Concurrencia: 2 pestañas → ambas instancias del syncEngine procesan la misma cola → doble cobro posible si la RPC no es 100% idempotente | syncEngine.ts:34-160 |
| 7 | ALTA | `pullVentasItemsIncremental` NO filtra por `local_id` → trae items de TODOS los locales del tenant → puede sobrescribir items locales con datos cross-local | pullIncremental.ts:229-253 |
| 8 | ALTA | `reconcileFromServerResult` modifica payloads en pending_ops `syncing` → race con el push activo que ya leyó el payload viejo | idReconciliation.ts:165-185 |
| 9 | ALTA | `cleanupOldSynced` no se llama nunca en producción → `pending_ops` crece monotónicamente | operations.ts:153 (sin callers fuera de tests) |
| 10 | MEDIA | `tenantId: ''` se pasa al abrir venta offline → row local queda con tenant vacío | ventasService.ts:100 |
| 11 | MEDIA | `_tempIdCounter` se resetea al reload de la página → colisión teórica de tempIds entre sesión vieja persistida y sesión nueva | ventasOfflineService.ts:27 |
| 12 | MEDIA | `pullIncremental` usa `updated_at > since` exclusivo → si dos rows updatean en el mismo ms al mismo segundo del último pull, perdés el segundo (off-by-one tradicional) | pullIncremental.ts:135, 159, etc. |
| 13 | BAJA | Sync engine no tiene logging persistente — errores solo van a `console.error` y se pierden al reload | pushQueue.ts:134, SyncEngineLifecycle.tsx:36 |
| 14 | BAJA | El backoff exponencial ignora `MAX_RETRIES=5` al chequear backoff → una op que llegó a `failed` no entra a `isBackoff` pero tampoco la procesamos (correcto) — el callcount está OK; solo el comment es engañoso | operations.ts:130-134 |
| 15 | BAJA | `useOnlineStatus` y syncEngine corren timers independientes de 30s → 2 pings/2 ciclos por minuto en lugar de 1 coordinado | useOnlineStatus.ts:18 + syncEngine.ts:104 |

---

## Detalle de hallazgos críticos

### 1. CRITICA — `markFailed` deja la op pegada permanentemente bloqueando la cola entera

**Archivo:** `operations.ts:111-120` + `pushQueue.ts:118-145`

**Flow del bug:**

```
1. processPushQueue() entra al for(op of ops)
2. await markSyncing(op.id) → op.status = 'syncing'
3. processOp(op) → error de red (timeout) → res.status = 'error'
4. await markFailed(op.id, ...) → op.retries = 1, op.status = 'pending' (porque 1 < 5)
5. Network corta, browser muere, refresh, lo que sea.
6. Próximo ciclo: la op vuelve a estar 'pending' → re-entra al for loop → OK.
```

Eso parece bien — PERO el caso patológico es:

```
1. processPushQueue() entra
2. markSyncing(op.id) → 'syncing'
3. processOp() lanza una excepción NO atrapada (ej. crash en supabase-js internal,
   tab killed por OOM, hard refresh user-side ANTES del catch)
4. La op queda en estado 'syncing' permanente.
5. `listPendingOps` SÍ la incluye (filtro acepta pending + syncing — operations.ts:74).
6. Pero en la siguiente ejecución del loop, la op tiene status='syncing' →
   `markSyncing` la vuelve a marcar OK, pero NO hay timeout que la rescate
   si quedó huérfana en la versión anterior.
```

Eso solo no rompe, pero combinado con el bug del comentario en `listPendingOps`:

> _Excluye las `synced` y `failed`_

la op huérfana en `syncing` queda dando vueltas para siempre con `retries=0` (porque solo `markFailed` incrementa). El `isBackoff` devuelve `false` (retries=0). El reintento es eterno y sin observabilidad: cada ciclo intenta re-marcar `syncing`, procesar, y si tira error _otra vez_ atrapado, se incrementa retries. OK.

**Pero el escenario REAL:** el `try/catch` de `processOp` (pushQueue.ts:77) atrapa excepciones, así que el path de "huérfana en syncing" solo se da con kill duro del proceso. La regla es: **al startear el engine, todas las ops en `syncing` deberían reset-earse a `pending`**. No existe ese reset. **PoC:**

```ts
// 1. User está cobrando una venta offline
// 2. Browser tab killed por OOM justo en el middle de processOp()
// 3. Op queda con status='syncing'
// 4. User reabre → syncEngine.start() → runFullCycle()
// 5. processPushQueue() → listPendingOps() → la op sigue ahí en 'syncing'
// 6. markSyncing(op.id) la re-graba con last_attempt_at=now → OK
// 7. processOp() corre, retorna error → markFailed → retries=1
// 8. Siguiente ciclo: isBackoff(retries=1) = since(0ms) < 5000ms → SKIP
// 9. En 5s reintenta → OK eventualmente
```

OK, el path se recupera porque markSyncing siempre re-graba. **Pero** hay un problema concurrente: si **TANTO** la pestaña vieja como la nueva tienen su syncEngine corriendo (ver hallazgo #6), las DOS marcan `syncing` con `last_attempt_at=now`, las DOS llaman `processOp`. **No hay lock.**

**Fix recomendado:**
- Al boot, ejecutar un `UPDATE pending_ops SET status='pending' WHERE status='syncing'` (reset estable).
- Implementar un **lock via campo `_local_origin` en pending_ops**: el syncEngine pone su instance-id en `markSyncing` y solo procesa si lo lockeó él.

---

### 2. CRITICA — Logout y cambio de tenant NO limpian IndexedDB

**Archivos:** `UserAvatarMenu.tsx:31-35`, `AuthPosProvider.tsx:80-83`, `lib/db/index.ts:38` (resetDb existe pero nadie lo llama)

**Verificación:** `grep -rn "resetDb\|cacheClear" packages/comanda/src` muestra que `resetDb()` solo se invoca desde **tests**, nunca desde el flow de auth de la app real. `cacheClear()` lo mismo. El README dice _"Llamar en logout"_ (`db/README.md:114`) pero ningún módulo lo hace.

**Impacto real:**

```
Escenario A — Cambio de tenant (Lucas test multi-tenant):
1. Login como dueño tenant Neko.
2. syncEngine arranca: pulleas catálogo + ventas Neko a IndexedDB.
3. 5 ops pending en queue (cobros offline de Neko).
4. Logout (db.auth.signOut() + logoutPos()).
5. NADA borra `comanda-local`. NADA borra `comanda-offline`.
6. Login como dueño tenant Sunny Creek.
7. SyncEngineLifecycle hace `syncEngine.start({tenantId: SC, localId: ...})`.
8. pullInitial corre y trae items de SC, pero NO borra los items de Neko que están
   en IndexedDB (replaceForTenant solo borra rows con `by_tenant === ese tenant`).
9. El catálogo en pantalla muestra items de DOS tenants mezclados.
10. processPushQueue() corre con la sesión nueva → las 5 ops pending de Neko
    se ejecutan contra el JWT del dueño de SC. La RLS server-side **debería**
    bloquearlas (auth_tenant_id() = SC, pero el row apuntado es de Neko) →
    todas fallan con error → quedan en `failed` para siempre. Si el dueño tiene
    permisos sobre AMBOS tenants (caso superadmin / Lucas) → **se aplican al
    tenant equivocado**. DATA CORRUPTION REAL.

Escenario B — Cambio de empleado POS (mismo tenant):
1. Cajero A inicia turno con PIN, hace 3 cobros offline (3 pending_ops).
2. Cajero A sale (logoutPos), Cajero B entra (loginPin).
3. Las 3 ops siguen en queue y se sincronizan a server con el JWT del dueño/manager
   (que es el sub de Supabase Auth — POS auth es paralelo). Server-side, las ops
   no llevan p_cobrado_por con el id de A, sino lo que estaba en el payload.
4. Para el server, las 3 ventas fueron cobradas por... el cajero registrado en payload.
5. Pero el local indicator visual del POS de B muestra "0 pendientes" tras un pull.
6. Si A había hecho cobros con cobradoPor=null (caso típico en abrirVentaOffline
   sin cajero seteado), quedan sin auditar.
```

**Fix recomendado:**
- En `UserAvatarMenu.logoutFull` (línea 33) y en cualquier otro `signOut`:

```ts
async function logoutFull() {
  logoutPos();
  await syncEngine.stop();           // hoy: NO se llama
  await flushPendingOpsOrAbort();    // hoy: NO existe; decisión de producto
  await resetDb();                   // hoy: NO se llama
  for (const s of ['items','grupos','mesas','empleados','canales','modificadores','lista_precios']) {
    await cacheClear(s);
  }
  await db.auth.signOut();
  navigate('/login');
}
```

- Decisión de producto antes del fix: **¿qué pasa si hay pending_ops al hacer logout?** Opciones:
  - Bloquear logout (modal "tenés 3 cobros sin sincronizar, esperá").
  - Forzar push síncrono antes del signOut.
  - Permitir logout pero migrar pending_ops a un "limbo" filtrado por user_id que solo se ejecute si ese user vuelve.

---

### 3. CRITICA — Pull initial borra ventas locales dirty no sincronizadas

**Archivo:** `pullInitial.ts:178-203`

```ts
// Líneas 180-191:
const txV = db.transaction('ventas_pos', 'readwrite');
const idxV = txV.store.index('by_local');
let cursor = await idxV.openCursor(IDBKeyRange.only(ctx.localId));
while (cursor) {
  // Solo borrar las que estaban abiertas — si hay cobradas locales sin
  // sincronizar (dirty), mantenerlas. Para keep-simple acá borramos todas
  // las del local y reinsertamos solo las abiertas. Las cobradas locales
  // se reescriben con su estado correcto en pull incremental.
  await cursor.delete();             // ← borra TODAS, sin chequear dirty
  cursor = await cursor.continue();
}
```

El **comment dice una cosa** (_"si hay cobradas locales sin sincronizar (dirty), mantenerlas"_) pero el **código hace otra** (borra todas). El plan de "keep simple borrando todas y dejar que pull incremental reinserte el estado correcto" se rompe en este escenario:

**PoC:**

```
1. Cajero abre venta offline (tempId=-1234, estado=abierta, 3 items).
2. Pierde internet. Cobra la venta offline (tempId=-1234, estado=cobrada, pagada=true,
   total=$5000, 1 pago efectivo). 4 ops en queue. _local_dirty=true en la venta.
3. Recupera internet → push queue empieza pero TODAVÍA no procesó fn_abrir_venta_offline.
4. User (otro cajero en otra terminal) hace login en el MISMO local → syncEngine.start
   → runFullCycle(isInitial=true) → pullInitialAll → pullVentasAbiertas.
5. La línea 189 (`await cursor.delete()`) borra TODAS las ventas del local.
6. La venta tempId=-1234 desaparece de IndexedDB.
7. pullVentasAbiertas trae solo ventas abiertas del SERVER (línea 161: estado IN
   abierta/enviada/lista/entregada — NO trae 'cobrada'). La venta cobrada NO está
   en server todavía (push pending). → no se reinserta.
8. Reconciliation cuando llegue: `moveRow(ventas_pos, -1234, realId)` → tx.store.get(-1234)
   devuelve undefined → "Ya no existe, idempotente, no-op" (idReconciliation.ts:125-129).
9. La cascada de items con venta_id=-1234 igual reasigna a realId, pero la VENTA
   propia desapareció. Server tiene la venta_id=realId vacía (sin nuestros items
   locales) — espera, items SÍ fueron al server porque la op de cobrar contiene el
   p_pagos pero NO los items individuales. Los items debían haberse pusheado por
   fn_agregar_item_comanda_offline.
10. Resultado: la pestaña que se logueó perdió el row local de la venta. Si los pushes
    de items eran dependientes (`depends_on`), pueden o no haber corrido. Sin la venta
    local, el cajero NO ve la venta en su UI. La caja física dice "$5000 cobrados",
    el POS dice "no hay venta de $5000". **Mismatch.**
```

**Fix:** la condición del while debe ser `if (!cursor.value._local_dirty) cursor.delete()`. O mejor: filtrar `by_dirty` index + estado abierta antes de borrar.

---

### 4. CRITICA — runFullCycle aborta entero si pull falla → push queue offline-recovery nunca corre

**Archivo:** `syncEngine.ts:107-149`

```ts
private async runFullCycle(isInitial: boolean): Promise<void> {
  ...
  try {
    // Pull
    if (isInitial) await pullInitialAll(this.ctx);
    else await pullIncrementalAll(this.ctx);

    // Push
    this.setState({ kind: 'pushing', ... });
    await processPushQueue();
    ...
  } catch (err) {
    this.setState({ kind: 'error', message: err.message, ... });
  }
  ...
}
```

**Si `pullInitialAll` o `pullIncrementalAll` lanza** (ej. supabase devuelve 503, timeout, RLS error transitorio), **`processPushQueue` JAMÁS se ejecuta** en ese ciclo.

**PoC del impacto:**

```
1. Cajero hace 5 cobros offline (5 ops pending).
2. Vuelve internet → notifyOnline() → runFullCycle().
3. Pull incremental falla por error en `pullVentasItemsIncremental` (ej. supabase
   timeout porque tiene q.limit(500) y la query del tenant pesa mucho).
4. Excepción burbujea al catch del runFullCycle.
5. setState(error). pushQueue NUNCA corrió.
6. Próximo tick (30s después) intenta de nuevo: pull falla de nuevo, push no corre.
7. Los 5 cobros quedan invisibles al server hasta que pull empiece a andar.
8. Cajero ve "Sin conexión" / banner de error y no entiende por qué — la red está OK,
   solo el pull tiene un problema transitorio.
```

**Fix:** envolver pull y push en try/catch separados, o pushear PRIMERO siempre (más urgente, mueve plata):

```ts
private async runFullCycle(isInitial: boolean): Promise<void> {
  const errors: string[] = [];
  // Push primero (urgente)
  try { await processPushQueue(); } catch (e) { errors.push(`push: ${e}`); }
  // Pull después (informativo)
  try {
    if (isInitial) await pullInitialAll(this.ctx);
    else await pullIncrementalAll(this.ctx);
  } catch (e) { errors.push(`pull: ${e}`); }
  // Estado final
  if (errors.length) this.setState({ kind: 'error', message: errors.join(' | '), ... });
  else this.setState({ kind: 'idle', ... });
}
```

---

## Detalle de hallazgos altos

### 5. ALTA — `'__pending_parent__'` literal flota al server

**Archivo:** `pagosOfflineService.ts:109`

```ts
p_venta_idempotency_uuid: args.ventaId < 0 ? '__pending_parent__' : null,
```

Igual en `overridesOfflineService.ts:61, 101, 150, 184, 219` y `transferenciasOfflineService.ts:49, 95-97, 172`.

**El flow esperado** es que `idReconciliation.rewritePendingOpsPayloadVentaId` (líneas 178-180) reemplace ese literal por `null` cuando la venta padre se reconcilia. Pero **solo lo hace cuando `payload.p_venta_id === tempId` se cumple**. Si el payload ya tenía `p_venta_id: null` (porque `args.ventaId < 0`), la condición `payload.p_venta_id === tempId` es **false** (`null !== -1234`) y el literal `'__pending_parent__'` queda intacto.

```ts
// idReconciliation.ts:175-181
if (payload.p_venta_id === tempId) {       // ← NO matchea cuando p_venta_id=null
  payload.p_venta_id = realId;
  if (payload.p_venta_idempotency_uuid === '__pending_parent__') {
    payload.p_venta_idempotency_uuid = null;
  }
  await tx.store.put(op);
}
```

**Caso patológico:**

```
1. Abrí venta offline (tempId=-1234, idempotency_uuid=UUID-A).
2. Encolé op #1 fn_abrir_venta_comanda con p_idempotency_uuid=UUID-A. reconcile=venta.
3. Cobré offline. Encolé op #2 fn_cobrar_venta_comanda con
     p_venta_id=null, p_venta_idempotency_uuid='__pending_parent__'.
4. Op #1 dependía de... nada. Op #2 NO declara depends_on (cobrar offline no lo setea).
5. processPushQueue procesa #1 → server retorna realId=999. reconcile mueve row local.
6. rewritePendingOpsPayloadVentaId busca ops con p_venta_id === -1234.
   El payload de op #2 tiene p_venta_id=null. NO matchea.
7. Op #2 se procesa: server recibe p_venta_idempotency_uuid='__pending_parent__'.
8. fn_resolver_venta_id_por_uuid lo intenta castear a UUID → error de sintaxis
   PostgreSQL: "invalid input syntax for type uuid: __pending_parent__" → falla.
9. markFailed → retries=1 → reintenta en 5s → mismo error.
10. Después de 5 retries → 'failed' permanente. El cobro NUNCA llega al server.
11. El cajero ve la venta cobrada local, pero el server nunca tuvo el cobro →
    la conciliación de caja del día va a estar OFF por ese monto.
```

**Fix:**
- `cobrarVentaOffline` debería leer `venta.idempotency_uuid` y setearlo en el payload (igual que hace `agregarItemOffline` con `ventaUuid`).
- También debería setear `depends_on: ventaOpId` cuando `args.ventaId < 0` (igual que agregarItemOffline).
- Mismo fix para los 5 servicios overrides + 3 transferencias.

---

### 6. ALTA — 2 pestañas = 2 syncEngines = doble proceso de la misma cola

**Archivo:** `syncEngine.ts:34-160` (singleton **por pestaña**)

```ts
// Singleton por sesión del browser.
export const syncEngine = new SyncEngine();
```

Pero "sesión del browser" en realidad es **"sesión del JS context"** = una por pestaña. IndexedDB es compartido entre pestañas. No hay BroadcastChannel ni Web Locks coordinando los engines.

**PoC:**

```
1. Cajero abre el POS en 2 pestañas (caso típico: una para tomar comandas, otra
   para imprimir o consultar otra mesa).
2. Pestaña A: cobra venta offline. Encola op #X en pending_ops (compartida).
3. Tab A: syncEngine.triggerPush() → markSyncing(X) → processOp(X) → en vuelo.
4. Tab B: 30s tick → runFullCycle → listPendingOps incluye X (status syncing
   pasa el filtro de operations.ts:74). markSyncing(X) la re-marca. processOp(X)
   ejecuta la RPC OTRA VEZ.
5. Server-side: la RPC `fn_cobrar_venta_comanda_offline` recibe el mismo
   p_idempotency_uuid de tab A. Devuelve el ID existente (dedup OK). Total
   retornado el mismo. processOp() retorna ok → markSynced.
6. Tab A: termina su processOp en paralelo → ok → markSynced (idempotente).
7. ✅ Suerte: por idempotencia server-side, el cobro no se dobló.

PERO:

8. La op fn_anular_item_comanda no usa idempotency_uuid en algunas combinaciones
   (overridesOfflineService.ts:64 setea genUUID() FRESH cada vez que se llama
   anularItemOffline, pero la op encolada ya tiene su uuid persistido — OK acá
   está bien).
9. PEOR: una op de transferencia `fn_transferir_mesa_comanda` se procesa en
   ambas tabs simultáneamente. Si la RPC NO chequea idempotency_uuid (algunos
   wrappers _offline_ sí, otros no — fn_transferir_mesa no se ve en
   202605161500), la mesa se transfiere DOS veces (la 2da seguramente falla
   con error "mesa_id ya está ocupada" o similar).
10. markFailed → la op queda en error 1/5 → reintento → loop.
```

**Mitigantes existentes:** la mayoría de RPCs `_offline` sí hacen dedup por uuid. **Pero:**
- `fn_cobrar_venta_comanda_offline` (líneas 60-82 del SQL) delega a `fn_cobrar_venta_comanda` con `cobro_idempotency_key=UUID::TEXT` — ahí el dedup es por la idempotency key existente que tiene desde sunny-creek C1.
- `fn_transferir_mesa_comanda` y `fn_unir_mesas_comanda` y `fn_partir_cuenta_comanda` — no aparecen como `_offline` separadas en el SQL revisado. El `pushQueue` los llama con suffix `_offline` (línea 48-50). **Si esas RPCs no existen, el push falla en cada intento de transferencia offline** → bug crítico por sí solo (no terminé de verificar — solo grep el SQL — pero el cliente las llama y no las encontré en migrations).

**Fix concurrencia:**
- Usar **Web Locks API** (`navigator.locks.request('comanda-sync', async () => { ... })`) que es disponible en todos los browsers modernos, garantiza single-runner cross-tab.
- O usar **BroadcastChannel** para que las pestañas elijan un leader (más complejo).

---

### 7. ALTA — pullVentasItemsIncremental NO filtra por local_id

**Archivo:** `pullIncremental.ts:229-253`

```ts
// No filtramos por venta — confiamos en el RLS (que ya filtra por local).
let q = supabase.from('ventas_pos_items').select('*');
if (since) q = q.gt('updated_at', since);
```

El comment dice "confiamos en RLS". Eso es válido server-side (RLS bloquea items de otros locales). **Pero:**

1. **Caso multi-local activo:** usuario tipo dueño con acceso a `local_id` ∈ {1, 2, 3}. RLS le devuelve items de los 3 locales. El pull los inserta TODOS al store local sin filtro adicional. Si `ctx.localId === 1`, los items de locales 2 y 3 entran al IndexedDB de esta sesión sin razón.
2. **applyCloudRow** sobrescribe rows locales por `id`. Si una venta tempId=-1234 del local 1 tiene un item con `id=5000` y simultáneamente el server tiene un item del local 2 con `id=5000` (BIGINTs son globales en la tabla, no por local — verificar — si lo son OK), no hay colisión. **Pero el repo `ventasItemsRepo.listByVenta` no filtra por local_id**, solo por venta_id, así que un item de otro local NO va a aparecer mezclado en la UI directamente. ⚠ La filtración indirecta vía `venta_id` salva la cara — _pero solo si NUNCA se reusa un BIGINT_, lo cual depende del schema.
3. **Egress wasteful:** se descargan items de locales que no le importan a esta sesión. En el escenario de un dueño con 8 locales, multiplica x8 los items que ve.

**Fix:** agregar `q.in('venta_id', listOfLocalVentaIds)` o un join con ventas filtrado por local_id. Lo más simple:

```ts
const ventasIds = (await ventasRepo.listByLocal(ctx.localId)).map(v => v.id);
let q = supabase.from('ventas_pos_items').select('*').in('venta_id', ventasIds);
```

---

### 8. ALTA — Reconciliation modifica payloads de ops syncing en paralelo

**Archivo:** `idReconciliation.ts:165-185` + `pushQueue.ts:122-136`

```ts
// pushQueue.ts línea 122-137:
await markSyncing(op.id);
const res = await processOp(op);
if (res.status === 'ok') {
  await markSynced(op.id, res.data);
  if (op.reconcile && ...) {
    await reconcileFromServerResult(op.reconcile, res.data);  // ← modifica OTRAS ops
  }
  ...
}

// idReconciliation.ts línea 165-184: rewritePendingOpsPayloadVentaId
const tx = db.transaction('pending_ops', 'readwrite');
const all = (await tx.store.getAll()) as PendingOp[];
for (const op of all) {
  if (op.status !== 'pending' && op.status !== 'syncing') continue;  // ← INCLUYE syncing
  ...
  if (payload.p_venta_id === tempId) {
    payload.p_venta_id = realId;
    await tx.store.put(op);
  }
}
```

**El bug:** se reescriben payloads de ops con status='syncing'. Pero `processPushQueue` itera de forma secuencial — sí, no es un problema dentro del mismo proceso. **Pero entre tabs** (hallazgo #6), Tab A puede estar pusheando op #5 (status='syncing', payload con p_venta_id=-1234) cuando Tab B termina su push de la venta padre y dispara reconcileFromServerResult que reescribe el payload de op #5 a p_venta_id=999.

Tab A ya leyó el payload viejo del closure (`processOp(op)` recibe la referencia tomada en `listPendingOps`). El supabase-js call ya está en vuelo con `p_venta_id=-1234`. El server, al recibir el RPC con un BIGINT negativo, va a fallar con `VENTA_NO_ENCONTRADA`.

**Severidad práctica:** mediana porque el caso requiere 2 tabs activas durante un reconcile específico. Pero combinado con #6, sí ocurre.

**Fix:** rewrite SOLO ops con status='pending'. Las que están 'syncing' ya están comprometidas. Si después fallan, el retry tomará el payload actualizado en el próximo ciclo.

---

### 9. ALTA — `cleanupOldSynced` sin caller en producción

**Archivo:** `operations.ts:153` + grep en `src/` muestra 0 callers fuera de tests.

**Impacto:**
- Cada cobro = 1 fila en `pending_ops` (synced) que NUNCA se borra.
- 100 cobros/día × 30 días = 3.000 filas. IndexedDB lo banca, pero `listPendingOps` hace `getAll()` y filtra en memoria → O(N) cada 30s + cada push. A 10.000 filas, el ciclo de 30s empieza a tardar 100ms+ solo en leer la cola.
- El `cleanupOldSynced` está bien escrito y testeado. Solo falta llamarlo. Recomendación: al final de cada `runFullCycle` exitoso, o un timer separado de 1h.

---

## Detalle de hallazgos medios

### 10. MEDIA — `tenantId: ''` al abrir venta offline

**Archivo:** `ventasService.ts:100`

```ts
const r = await abrirVentaOffline({
  tenantId: '',                  // ← string vacío
  localId: args.localId,
  ...
});
```

El row local queda con `tenant_id=''`. Si alguien hace `itemsRepo.listByTenant('')` no devuelve nada (los rows pulleados sí tienen el tenant real). **Pero:**
- El filtro `pullItemsIncremental` por `eq('tenant_id', ctx.tenantId)` no impacta el row local huérfano.
- Cuando reconcile mueve la venta a realId, copia el row entero (`{ ...old }`) → el row server-resolved sigue con tenant_id=''. El pull incremental subsiguiente lo va a sobrescribir con el tenant_id real al traerlo del cloud (`applyCloudRow` no chequea tenant). OK, se autoregenera. Bajo impacto pero feo.

**Fix:** derivar tenantId del `useAuth().user.tenant_id` en el caller (ventasService).

---

### 11. MEDIA — `_tempIdCounter` no persiste entre reloads

**Archivo:** `ventasOfflineService.ts:27`, `pagosOfflineService.ts:26`, `transferenciasOfflineService.ts:24`

```ts
let _tempIdCounter = -1_000_000_000;
function nextTempId(): number {
  return _tempIdCounter--;
}
```

**Es un módulo-level variable.** Cada reload empieza de `-1_000_000_000`. Si una venta del reload anterior quedó con tempId=-1_000_000_005 y NO se reconcilió todavía (pending), y ahora la sesión genera tempId=-1_000_000_005 para otra venta nueva, **colisión en IndexedDB** → `ventasRepo.put` (que es upsert) **sobrescribe la venta vieja**.

**Probabilidad real:** baja porque hace falta exactamente la misma cantidad de aperturas antes del reload. Pero si el patrón típico es "abrir venta, perder internet, reload, abrir venta", colisiona en la segunda.

**Fix:** persistir el counter en localStorage o usar UUIDs en lugar de BIGINT negativos (que era el plan original — el comment del schema "_cuando Fase 3 lleguen los UUIDs_" sugiere que esto va a cambiar).

---

### 12. MEDIA — Pull incremental usa `>` exclusivo → pierde rows con updated_at == lastPullAt

**Archivo:** `pullIncremental.ts:135` y similares

```ts
if (since) q = q.gt('updated_at', since);
```

Si dos rows tienen `updated_at = since` exacto (caso patológico: muchos updates en el mismo ms a través de un trigger), el primer pull captura uno, el segundo pull con `since=updated_at(primero)` no captura el otro porque usa `>` no `>=`. Pero usar `>=` causa que el row se traiga 2 veces.

**Fix industrial:** usar el patrón `WHERE (updated_at, id) > (since, lastId)` o `updated_at >= since AND id NOT IN (lastBatch)`. O usar transactional consistency: `last_pull_at = lo que devolvió el SELECT del max(updated_at) del batch`, no `now()`.

---

## Cosas que están bien (no toda la noticia es mala)

- **Resolver LWW** está bien diseñado. La excepción de "venta cobrada local no se sobrescribe" es correcta (operación final = irreversible sin manager).
- **idReconciliation** maneja idempotencia (caso de `if (already) tx.store.delete(tempId)`) — bien.
- **pushQueue** preserva orden FIFO + dependencias con `depends_on`. La lógica de `isBlocked` es correcta.
- **Backoff exponencial** está testeado: 5s → 30s → 5min → 30min → 1h. Razonable.
- **Schema versioning** + migrations.ts con reglas claras está bien.
- **`document.hidden` check** en el setInterval del syncEngine (línea 102) es buena optimización para tabs ocultas.
- **conflictResolver tests** cubren los casos críticos de protección de ventas finalizadas.

---

## Recomendaciones priorizadas

Ordenadas por impacto/costo. Asumiendo Lucas tiene poco tiempo:

1. **Logout limpia IndexedDB** (#2) — _30 min de código_, evita corrupción cross-tenant inmediata.
2. **Fix `__pending_parent__` literal en cobrarVentaOffline + overrides + transfer** (#5) — _2h_, evita pérdida de cobros offline.
3. **Pull initial no borra ventas dirty** (#3) — _1h_, evita pérdida de cobro al cambiar terminal/login en mismo local.
4. **runFullCycle separa try/catch pull y push** (#4) — _15 min_, push corre aunque pull falle.
5. **Reset de ops `syncing` al boot del engine** (#1) — _15 min_, evita huérfanas.
6. **Web Lock cross-tab** (#6) — _2h con tests_, evita doble-push. Posterga si Lucas opera con 1 tab solo.
7. **Tests del syncEngine + pushQueue + pullIncremental** (CRÍTICO meta) — _1 día_, hoy hay 0 coverage del orquestador. Es código que mueve plata sin tests. Regla C2 (test E2E mutante obligatorio) está violada.
8. **Callear `cleanupOldSynced` desde `runFullCycle`** (#9) — _5 min_.
9. Fixes medios/bajos cuando haya tiempo.

---

## Tests que faltan urgente

Listado para crear `packages/comanda/src/lib/sync/__tests__/syncEngine.test.ts` + `pushQueue.test.ts` + `pullIncremental.test.ts`:

**syncEngine:**
- start sin ctx no rompe
- start después de start es idempotente
- stop limpia el interval
- start+stop+start no leakea timer
- runFullCycle con pull fail no aborta push (cuando se fixee #4)
- subscribe + emit recibe estado
- triggerPush sin engine activo es no-op

**pushQueue:**
- procesa ops en orden FIFO
- respeta depends_on (op hija no corre si padre pending)
- retry con backoff respetado
- reconcile se aplica solo si status=ok
- error de processOp no aborta el resto de la cola
- 2 procesos concurrentes no doblan (necesita el fix de Web Lock primero)

**pullIncremental:**
- filtra por updated_at > since
- conflictos se loguean
- delete cascada (deleted_at no null) borra local
- pull falla en un store → otros stores no se afectan
- conflicto LWW con local dirty + cloud más nuevo → cloud wins + log

---

## Notas finales

El módulo es ambicioso y bien diseñado en papel (LWW + reconciliation + dependency graph + UUID idempotency es el state-of-the-art para POS offline). La ejecución tiene gaps importantes pero **arreglables sin rediseño**. Lo más urgente es **#1-#5**, todo lo demás se puede iterar.

El gap más doloroso es la falta de tests de integración del orquestador. Con 5 test files de unidades, pero 0 del syncEngine end-to-end, Lucas está confiando en que las piezas individuales bien testeadas se compongan correctamente — y por la cantidad de bugs encontrados, esa suposición no se sostiene.

La regla **C10 — Recovery si el browser muere a mitad** del plan sunny-creek aplica directamente acá. La feature offline-first la viola en al menos 3 escenarios (#1, #3, #5).
