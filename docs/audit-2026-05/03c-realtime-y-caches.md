# Fase 3C — Supabase Realtime, caches locales, polling y refetch

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Scope:** `packages/pase/src/lib/{useRealtimeTable,useCategorias,useMediosCobro,useBandejaEntrada,usePuestosRRHH,useTenantFeatures,supabase}.ts`, `packages/pase/src/{App.tsx,pages/Caja.tsx,pages/Compras.tsx,pages/Usuarios.tsx,pages/ConciliacionMP.tsx,pages/CodigosManager.tsx,components/ManagerOverrideModal.tsx,dashboards/widgets/*}`, `packages/comanda/src/lib/{useRealtimeTable,useVisiblePolling,useOnlineStatus,offlineCache,usePermiso,sync/*,db/*,authPos,localActivo,featureFlags,supabase,supabaseAnon}.ts`, todas las pantallas POS/Settings/Reportes que invocan `useRealtimeTable`.
**Método:** lectura estática + grep dirigido (`useRealtimeTable`, `setInterval`, `visibilitychange`, `sessionStorage.`, `localStorage.`, `createClient`), correlación de subscriptions vs. handlers vs. cleanup, mapping de stores IndexedDB en COMANDA, conteo de instancias `createClient`.

---

## 📊 Resumen ejecutivo

| Métrica | Valor | Comentario |
|---|---|---|
| Hooks `useRealtimeTable` invocados en PASE (sin contar hook def) | **15** en 9 archivos | Todos scopeByTenant=true por default. 0 con `scopeByLocal: true`. |
| Hooks `useRealtimeTable` invocados en COMANDA | **26** en 19 archivos | 19 con `scopeByLocal: true`. Filtros `extraFilter` por venta_id en 3. |
| **Subs Realtime "estado base" por user PASE (sin Caja/Compras abierto)** | **5** | useCategorias + useMediosCobro + usePuestosRRHH + useBandejaEntrada×3 (3 tablas: notes/overrides/solicitudes) = 5–6 con dueño. |
| **Subs Realtime "máximo" por user PASE (Caja+Compras+Usuarios+widget)** | **5 base + 2 Caja + 3 Compras + 3 Usuarios + 1 widget = ~14 simultáneas** | El default plan Supabase Realtime tiene 100 channels concurrent/cliente — lejos del límite, pero relevante en cuanto a egress + handler debounce. |
| **Subs Realtime "estado base" por user COMANDA (POS pantalla mesas)** | **8–11** | Catálogo (4: mesas, ventas_pos, items, metodos_cobro) + paneles laterales + ComandasActivasPanel. |
| Polls `setInterval` activos en runtime (sin contar definiciones internas de hooks) | **PASE: 3 — COMANDA: 14** | El nuevo `useVisiblePolling` mitigó algunos, pero el grueso sigue siendo polling crudo. |
| Caches `sessionStorage` con TTL | **8** (PASE 5 / COMANDA 3) | TTL 1h (categorias, medios, puestos, permisos POS), 5min (tenant_features), 60s (items COMANDA). |
| Caches `localStorage` (sin TTL, persistentes) | **9** (PASE 5 / COMANDA 4) | inbox-read, theme, mp-periodo, print-bridge-url, onboarding-seen, feature flags, mute, mp-token (COMANDA), local-activo. |
| Stores IndexedDB COMANDA | **2 DBs distintos**, 17 stores total | `comanda-offline` (7 stores cache stale-while-revalidate) + `comanda-local` (10 stores sync engine offline-first). |
| Instancias `createClient` Supabase | **4** | 1 por package (`pase`, `admin-console`, `comanda` principal) + 1 anon-no-session en COMANDA para flujos públicos. **Limpio.** |

### Hallazgos top — ranking por impacto

| # | Finding | Tipo | Severidad |
|---|---|---|---|
| 1 | `useBandejaEntrada` dispara **reload completo** de 6 queries en paralelo en cada INSERT a `dashboard_pinned_notes`/`manager_override_usos`/`manager_solicitudes` — sin debounce extra, sin diff de cuál tabla cambió, sin merge | network/CPU | 🔴 ALTO |
| 2 | `useCategorias` + `useMediosCobro` + `usePuestosRRHH` cada uno mantiene 1 sub Realtime PERMANENTE sobre tabla catálogo que cambia 1 vez por mes → 3 channels gastados 24×7 por user para invalidar cache de 1h. Mejor: invalidación on-focus + `BroadcastChannel` cross-tab | network/idle energy | 🟠 ALTO |
| 3 | `Caja.tsx` suscribe 2 tablas (`movimientos` + `saldos_caja`); cada cambio en saldos dispara `load()` que re-pega 4 queries (movimientos + count futuros + saldos + count exact). En un rush de POS con efectivo (que escribe `saldos_caja` por trigger), un dueño con Caja abierto recibe 1 reload completo cada segundo. Debounce 500 ms ayuda pero no agrupa los dos hooks juntos | network rush | 🔴 ALTO |
| 4 | **Cascada de polling backup que NO se necesita.** `PedidosHub` corre `useRealtimeTable` + `setInterval(reloadLight, 120s)`; varios hardware screens corren `setInterval(reload, 15s)` SIN useVisiblePolling y SIN realtime — quedan corriendo con pestaña oculta | network/energy | 🟠 ALTO |
| 5 | `ManagerOverrideModal` poll cada `POLLING_INTERVAL_MS` (3s) RPC `fn_consultar_solicitud` mientras el dueño no aprueba/rechaza. Si la solicitud expira (15min), son 300 RPCs sin necesidad. Mejor: Realtime sub a `manager_solicitudes WHERE id=eq.X` | network | 🟡 MEDIO |
| 6 | `CodigosManager.tsx` corre `setInterval` cada **1 segundo** para countdown del código TOTP. Cuando llega a 0 invoca `cargarCodigo()` + `cargarUsos()` (2 queries). Está OK como UX pero el tick re-render del componente cada 1s mientras la pantalla está abierta es costoso si hay muchos `<UsoRow>` | rendering | 🟡 MEDIO |
| 7 | **0 instancias de `React.memo` en todo el monorepo** (PASE + COMANDA). Components grandes como `CajaCardsRow`, `MovimientoRow`, `FacturaRow` se re-renderizan en cada `load()` aunque las props no cambien. Combinado con #3 es el principal driver de jank en Caja | rendering | 🟠 ALTO |
| 8 | `ConciliacionMP.tsx` arranca un `setInterval` interno de countdown 1s dentro de un `await new Promise(resolve=>...)` durante "sincronizar" — si el browser muere a mitad, no hay forma limpia de cancelarlo (no está en useEffect cleanup, es un closure local). El timer se cancela cuando `remaining<=0` resolve, pero si el user cierra la modal de sync, el interval sigue corriendo en background hasta llegar a 0 | leak menor | 🟢 BAJO |
| 9 | `comanda` sync engine usa `setInterval(runFullCycle, 30s)` SIN pause-on-hidden — un cocinero/cajero con el POS en una pestaña oculta sigue tirando 5 queries Supabase cada 30s (items + grupos + mesas + ventas + items) por terminal | network/energy | 🟠 ALTO |
| 10 | `useOnlineStatus` (COMANDA) hace ping a `locales` cada 30s **incluso con pestaña oculta** — multiplicado por N pestañas POS abiertas = N pings + count exact / 30 s independientemente de uso real | network/energy | 🟡 MEDIO |
| 11 | `useBandejaEntrada` los `fetchFacturasVencidas` / `fetchFacturasPorVencer` / `fetchMpSinConciliar` tienen `// eslint-disable applyLocalScope` por diseño — fan-out cross-local correcto, pero **no hay filter por `local_id` ni `fecha` en sub Realtime** → si en otro local del mismo tenant se crea una factura, el hook re-fetcha las 6 queries del user actual aunque la novedad no le aplique | network | 🟡 MEDIO |
| 12 | El cache `useCategorias` se invalida correctamente cuando otro tab edita; **pero** entre el cache `sessionStorage` (TTL 1h) y el Realtime sub, ambos siguen siendo redundantes si Realtime funciona. Si Realtime falla, fallback polling cada 60s ya cubre — el TTL de 1h del sessionStorage pierde sentido tras agregar Realtime. Bug benigno: cache muerto que vive | tech debt | 🟢 BAJO |
| 13 | `localStorage.pase_inbox_read` (PASE) crece sin GC — cada notif id leída queda PARA SIEMPRE en el map. Después de 6 meses de uso real va a llegar a 5 MB (límite localStorage) | UX bug futuro | 🟡 MEDIO |
| 14 | Item subscribe en `MateriasPrimasLista` / `DisponibilidadLista` (COMANDA) suscribe `items` sin `scopeByLocal` — items son globales por tenant, OK. Pero cada disponibilidad-cambio dispara `reload()` de TODOS los items del tenant. Si un tenant tiene 200 items y 5 cambios/min en hora pico, son 5 SELECT items * todos los pantallazos abiertos. Mejor: aplicar el diff del row al state local | network | 🟡 MEDIO |
| 15 | El handler `onChange` de TODOS los `useRealtimeTable` del repo dispara `load()` completo — **0 implementaciones de merge incremental del row recibido**. Realtime te entrega `payload.new` y `payload.old`, pero el hook actual descarta esa información y solo dispara el callback. Costo de oportunidad grande | arquitectura | 🟠 ALTO |

**Para atacar primero:** #3 (Caja rush) + #1 (Bandeja fan-out) + #4 (polling backup que no se necesita) + #7 (React.memo ausente). Los cuatro son la mayor parte del egress + jank percibido. #15 es el rediseño que rinde más a largo plazo.

---

## 1. Auditoría detallada de `useRealtimeTable`

### 1.1 Cobertura PASE — 15 invocaciones en 9 archivos

| Archivo:línea | Tabla | scopeByTenant | scopeByLocal | events | debounceMs | Notas |
|---|---|---|---|---|---|---|
| `pages/Compras.tsx:329` | `facturas` | default true | false | default ALL | default 500 | Reload completo de 4 queries. |
| `pages/Compras.tsx:330` | `remitos` | default true | false | default ALL | default 500 | idem. |
| `pages/Compras.tsx:331` | `proveedores` | default true | false | default ALL | default 500 | Catálogo — cambia raras veces. Sobra como Realtime, mejor invalidate-on-focus. |
| `pages/Caja.tsx:346` | `movimientos` | default true | false | default ALL | default 500 | Cada cambio dispara `load()` de 4 queries (cuenta saldos + cuenta futuros + paginated movs + saldos visibles). |
| `pages/Caja.tsx:347` | `saldos_caja` | default true | false | default ALL | default 500 | **Trigger-driven**: cada mov inserta/edita `saldos_caja` por trigger ⇒ DOBLE evento por op. |
| `pages/Usuarios.tsx:78` | `usuarios` | default true | false | default ALL | default 500 | OK frecuencia baja. |
| `pages/Usuarios.tsx:79` | `usuario_permisos` | default true | false | default ALL | default 500 | OK frecuencia baja. tenant_id existe en tabla (mig 202604281201). |
| `pages/Usuarios.tsx:80` | `usuario_locales` | default true | false | default ALL | default 500 | idem. |
| `dashboards/widgets/UltimosOverridesWidget.tsx:115` | `manager_override_usos` | default true | false | `[INSERT]` | **200** | Solo INSERT, debounce explícito bajo para feedback inmediato. OK. |
| `lib/useBandejaEntrada.ts:297` | `dashboard_pinned_notes` | default true | false | `[INSERT, UPDATE]` | default 500 | Triggea reload de 6 queries (ver #1). |
| `lib/useBandejaEntrada.ts:303` | `manager_override_usos` | default true | false | `[INSERT]` | default 500 | idem. Condicional a permiso `codigos_manager`. |
| `lib/useBandejaEntrada.ts:310` | `manager_solicitudes` | default true | false | `[INSERT, UPDATE]` | default 500 | idem. Solo dueno/admin/superadmin. |
| `lib/useCategorias.ts:251` | `config_categorias` | default true | false | default ALL | default 500 | Cross-tab cache invalidation. Catálogo cambia 1 vez al mes. |
| `lib/useMediosCobro.ts:165` | `medios_cobro` | default true | false | default ALL | default 500 | idem. |
| `lib/usePuestosRRHH.ts:104` | `rrhh_puestos` | default true | false | default ALL | default 500 | idem. |

**Total subs PASE permanentes (cualquier user logueado, ninguna pantalla "pesada" abierta):**
- `useCategorias` + `useMediosCobro` + `usePuestosRRHH` = 3 channels (montados desde Sidebar/Header que están siempre montados).
- `useBandejaEntrada` 3 channels (3 tablas) — montado en topbar para mostrar campanita.
- → **6 channels permanentes por user**, incluso en /inicio sin tocar nada.

**Subs adicionales por pantalla:**
- `/caja` abierto: +2 channels.
- `/compras` abierto: +3 channels.
- `/usuarios` abierto: +3 channels.

**Pico realista (dueño con /caja + topbar):** 8 channels. Plan Supabase free: 200 concurrent connections + 100 channels/conn. Lejos del límite hard, pero cada channel implica egress permanente del JWT y los heartbeats.

### 1.2 Cobertura COMANDA — 26 invocaciones en 19 archivos

Resumen por pantalla (con `scopeByLocal`):

| Archivo | Tabla(s) | scopeByLocal | extraFilter | onChange |
|---|---|---|---|---|
| `components/ComandasActivasPanel.tsx:47` | `ventas_pos` | true | — | `reload` (1 query). Combina con `useVisiblePolling(reload, 90_000)`. |
| `pages/Empleados/EmpleadosTrabajando.tsx:100` | `turnos_caja` | default false | — | `reload`. |
| `pages/Caja/CajaHistorico.tsx:35` | `turnos_caja` | true | — | `reload`. |
| `pages/Caja/CajaEstado.tsx:46,47` | `turnos_caja` + `movimientos_caja` | true | — | `reload` (idem patrón Caja PASE). |
| `pages/Caja/CajaChica.tsx:100` | `movimientos_caja` | true | — | `reload`. |
| `pages/Integraciones/LogWebhooksExternos.tsx:59` | `pedidos_externos_log` | default false | — | `reload`, debounce 2000ms (bueno, alto throughput). |
| `pages/Catalogo/MateriasPrimasLista.tsx:42` | `materias_primas` | default false | — | `reload` — catálogo. |
| `pages/Catalogo/DisponibilidadLista.tsx:57` | `items` | default false | — | `reload` — catálogo. |
| `pages/Settings/SettingsMesas.tsx:46` | `mesas` | default false | — | `reload`. |
| `pages/Settings/SettingsMenuQr.tsx:40` | `menu_qr_tokens` | true | — | `reload`. |
| `pages/Settings/SettingsKds.tsx:47` | `kds_tokens` | true | — | `reload`. |
| `pages/Settings/SettingsEmpleados.tsx:56` | `rrhh_empleados` | default false | — | `reload`. |
| `pages/Settings/SettingsMetodosCobro.tsx:38` | `metodos_cobro` | default false | — | `reload`. |
| `pages/Settings/SettingsPermisos.tsx:34` | `usuario_permisos` | default false | — | `reload`. |
| `pages/Settings/SettingsAuditoria.tsx:81` | `ventas_pos_overrides` | true | — | `reload`. |
| `pages/Reportes/Dashboard.tsx:61` | `ventas_pos` | true | — | `reload`, debounce 3s (bueno). |
| `pages/Reportes/ReporteCanales.tsx:23` | `ventas_pos` | true | — | `reload`. |
| `pages/Reportes/ReporteMenuEngineering.tsx:103` | `ventas_pos` | true | — | `reload`. |
| `pages/Reportes/ReporteTiempos.tsx:30` | `ventas_pos` | true | — | `reload`. |
| `pages/Reportes/ReporteVentas.tsx:94` | `ventas_pos` | true | — | `reload`. |
| `pages/Reportes/ReporteProductos.tsx:23` | `ventas_pos_items` | default false | — | `reload`, debounce 3s. |
| `pages/Online/TrackingDelivery.tsx:67` | `ventas_pos` | true | — | `reload`. |
| `pages/Pos/MostradorView.tsx:95` | `ventas_pos` | true | `modo=eq.mostrador` | `reload`. ✅ buen uso de extraFilter. |
| `pages/Pos/PedidosHub.tsx:152` | `ventas_pos` | true | `modo=eq.pedidos` | `reloadLight`. ✅ buen patrón. |
| `pages/Pos/SalonView.tsx:59,60` | `mesas` + `ventas_pos` | true | `modo=eq.salon` (la 2da) | `reload`. ✅. |
| `pages/Pos/HandheldView.tsx:151,152,322` | `mesas` + `ventas_pos` (modo=salon) + `ventas_pos_items` (venta_id=eq.X) | true (las 2 primeras) | sí | `reload`. ✅ extraFilter por venta_id. |
| `pages/Pos/VentaScreen.tsx:162` | `ventas_pos` | default false | `id=eq.X` | `reloadVenta`. ✅. |
| `pages/Pos/PedidoDetalle.tsx:65,71` | `ventas_pos` + `ventas_pos_items` | default false | `id=eq.X` / `venta_id=eq.X` | `reload`. ✅. |

**Buenos patrones COMANDA:**
- `extraFilter` correctamente usado en SalonView, MostradorView, PedidosHub, VentaScreen, PedidoDetalle, HandheldView.
- Debounces explícitos altos donde corresponde (Reportes: 3s; LogWebhooks: 2s).
- `scopeByLocal: true` consistente en 19 de 26 — solo catálogos cross-local (items globales por tenant) y settings van con scope tenant.
- `ComandasActivasPanel` combina Realtime + `useVisiblePolling(90s)` en lugar de polling agresivo — patrón modelo.

**Malos patrones COMANDA:**
- `Reportes/*` mantiene Realtime sobre `ventas_pos` aunque el report sea histórico — un usuario abriendo el dashboard de mes pasado igual recibe eventos de ventas live. Mejor: condicionar `enabled` al rango de fechas seleccionado.
- 5 reportes distintos (Canales, Tiempos, Ventas, MenuEngineering, Productos) abren cada uno 1 channel sobre `ventas_pos` — si el dueño abre los 5 en pestañas distintas son 5 channels sobre la misma tabla. Una unificación a un store compartido (e.g. zustand) eliminaría redundancia.

### 1.3 Unsubscribe + leaks

**El hook `useRealtimeTable` (ambas versiones PASE y COMANDA) cleanup-ea correctamente:**
```ts
return () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (pollTimer) clearInterval(pollTimer);
  document.removeEventListener('visibilitychange', handleVisibility);
  if (channel) { try { db.removeChannel(channel); } catch { /* */ } }
};
```
✅ debounceTimer + pollTimer + listener + channel: todos limpios. No hay leak.

**EVENTS_DEFAULT** es una constante referencialmente estable (no array literal inline) — bug documentado en el header. ✅.

### 1.4 Handler: reload completo vs merge incremental

🔴 **Patrón sistémico:** todos los `onChange` invocan `load()` / `reload()` que vuelve a fetchear todo el dataset. Supabase Realtime entrega `payload.new` / `payload.old` con la fila completa, pero el hook current solo expone `() => void`.

**Costo:** un cambio de 1 row en `ventas_pos` dispara `SELECT * FROM ventas_pos LIMIT 200` en cada pantalla Realtime suscrita (en hora pico con 10 pantallas POS + reportes abiertos, son 10 SELECTs full por cada cobro).

**Fix arquitectónico (largo plazo):**
```ts
useRealtimeTable<VentaPos>({
  table: 'ventas_pos',
  onUpsert: (row) => setVentas(prev =>
    prev.some(v => v.id === row.id)
      ? prev.map(v => v.id === row.id ? row : v)
      : [row, ...prev].slice(0, 200)
  ),
  onDelete: (id) => setVentas(prev => prev.filter(v => v.id !== id)),
});
```
Cambio del hook + cambio progresivo en consumers. Ahorra ~80% del egress de Realtime.

---

## 2. Polling con `setInterval`

### 2.1 PASE

| Archivo:línea | Interval | Cleanup | Visibility-aware | Necesario? |
|---|---|---|---|---|
| `lib/useRealtimeTable.ts:113,143,152` | 30/60s | ✅ | ✅ (skipea si hidden) | Fallback si Realtime falla. OK. |
| `pages/ConciliacionMP.tsx:416` | 1s × 120 ticks | ✅ dentro del closure | ❌ | UX de countdown post-fetch. Bug menor: si el user cierra la modal antes del minuto 2, sigue corriendo hasta que `remaining<=0`. |
| `pages/CodigosManager.tsx:113` | 1s | ✅ | ❌ | Countdown del TOTP. Re-render por tick. **Mejor: derivar segundos restantes de `(expira_at - now)` con `useEffect` que tickea Date.now() cada 1s**, sin disparar setState innecesarios. |
| `components/ManagerOverrideModal.tsx:129` | `POLLING_INTERVAL_MS` (3s) | ✅ | ❌ | Espera de aprobación del dueño. 300 RPCs/15min. **Mejor: useRealtimeTable sobre `manager_solicitudes` con `extraFilter: id=eq.X`**. |

### 2.2 COMANDA

| Archivo:línea | Interval | Cleanup | Visibility-aware | Necesario? |
|---|---|---|---|---|
| `lib/useRealtimeTable.ts:132/168/179` | 30/60s | ✅ | ✅ | Fallback. OK. |
| `lib/useVisiblePolling.ts:25,29` | variable | ✅ | ✅ | Helper bueno — pausa con tab hidden. |
| `lib/useOnlineStatus.ts:55` | 30s | ✅ | ❌ | **Sigue corriendo con pestaña oculta.** Ping a `locales` count exact. Por device con N pestañas = N pings/30s, todo el día. |
| `components/UrgencyTimer.tsx:18` | 1s | ✅ | ❌ | UI tick para mostrar tiempo transcurrido. OK pequeño. |
| `components/BusyModeButton.tsx:54` | 30s | ✅ | ❌ | Refresh del "vuelve en X min" — sigue corriendo con tab oculta. Migrar a useVisiblePolling. |
| `components/SyncStatus.tsx:26` | 10s | ✅ | ❌ | Re-render del "hace X seg" — tick de UI solamente, no fetch. OK mantener. |
| `lib/sync/syncEngine.ts:97` | 30s | ✅ | ❌ | **Crítico**: el sync engine pull+push CADA 30s sin chequear visibility. 5 queries por ciclo, sin pausa con tab oculta. |
| `pages/Salon/ReservasAdmin.tsx:79` | 60s | ✅ | ❌ | Migrar a useVisiblePolling o agregar Realtime sobre reservas. |
| `pages/Rider/RiderPWA.tsx:82,192` | `REFRESH_INFO_MS` + 30s | ✅ | ❌ | PWA del rider — corriendo en background INTENCIONALMENTE (tracking GPS). OK. |
| `pages/Kds/KdsView.tsx:76,109` | `POLL_MS` + 30s | ✅ | ✅ (usa useVisiblePolling) + ❌ (el de reloj) | El segundo es UI tick de reloj — OK. |
| `pages/Pos/SalonView.tsx:41` | 30s | ✅ | ❌ | Tick UI para "tiempo abierta". Lo mismo que UrgencyTimer. OK. |
| `pages/Pos/PedidosHub.tsx:156` | `POLL_MS` (120s) | ✅ | ❌ | Polling backup ADEMÁS de Realtime — redundante si Realtime funciona, pero baja frecuencia OK. |
| `pages/Delivery/DispatchMap.tsx:77` | `REFRESH_MS` | ✅ | ❌ | Posiciones rider. Posible candidato a Realtime sobre `riders_positions`. |
| `pages/Hardware/HardwareRiders.tsx:72` | 15s | ✅ | ❌ | **Crítico**: pantalla admin de hardware corriendo cada 15s con tab oculta. |
| `pages/Hardware/HardwareAgentes.tsx:84` | 15s | ✅ | ❌ | idem. |

**Conclusión polling:** 14 setInterval en COMANDA, **5 sin visibility-aware** que están corriendo desperdiciando recursos cuando el cocinero/admin abre otra pestaña: `useOnlineStatus`, `syncEngine`, `BusyModeButton`, `HardwareRiders`, `HardwareAgentes`. La migración a `useVisiblePolling` o agregar el patrón `document.visibilityState === 'hidden' → return` es 5 líneas por archivo.

---

## 3. Refetch on focus / visibilitychange

### PASE
- `lib/useRealtimeTable.ts:166` — handler `visibilitychange` que dispara `onChange` al volver visible, throttleado a 5s entre disparos. ✅ correcto pero **multiplica reloads**: si 6 hooks comparten una pantalla, al volver visible se llaman 6 `load()` (uno por hook) en paralelo. No hay throttle global.
- `dashboards/widgets/ProximoPasoWidget.tsx:87` — re-lee `localStorage` al volver visible (no hace fetch, OK).

### COMANDA
- `lib/useRealtimeTable.ts:192` — idem PASE.
- `lib/useVisiblePolling.ts:57` — el patrón canónico.

**Recomendación:** introducir un hook `useGlobalFocusRefresh()` que coalesca todos los callbacks de la pantalla a un único `requestIdleCallback` cuando se vuelve visible. Ahorra los N reloads simultáneos.

---

## 4. Caches en `sessionStorage` / `localStorage`

### 4.1 `sessionStorage` con TTL — PASE

| Key | TTL | Tamaño aprox | Invalidación | Riesgo stale |
|---|---|---|---|---|
| `pase_categorias_v7` | 1h | ~5 KB | Realtime sub + manual `refresh()` | bajo — RLS read fresh igual |
| `pase_medios_cobro_v1` | 1h | ~2 KB | Realtime sub + manual `refresh()` | bajo |
| `pase_puestos_rrhh_v1` | 1h | ~1 KB | Realtime sub + manual `refresh()` | bajo |
| `pase_tenant_features__<uuid>` | 5min | ~1 KB | manual `invalidateTenantFeaturesCache` | bajo — features cambia raras veces |
| `pase_user` | sin TTL (sesión) | ~10 KB (perms array) | logout / change-password | **medio**: si un admin agrega permisos al user logueado, el cache stale hasta logout (documentado en CLAUDE.md como "es UX, no security bypass" — RLS server-side ya filtra) |

### 4.2 `sessionStorage` sin TTL — PASE
| Key | Vida | Uso |
|---|---|---|
| `pase_local_activo` | sesión | local activo del encargado |
| `pase_tenant_override` | sesión | override de superadmin para "ver como tenant X" |
| `pase_idemp_pagarfac_<id>` / `pase_idemp_pagarrem_<id>` | hasta éxito | idempotency keys C1+C10. Borrados al success. **NO se borran si el user nunca llega a pagar** — quedan acumulándose hasta cerrar el browser. Bajo impacto (UUID de 36 chars * facturas no pagadas). |
| `chunk_reload_last` | sesión | guard anti-reload-loop. ✅ |

### 4.3 `localStorage` (persistente) — PASE
| Key | Tamaño actual | TTL | Riesgo |
|---|---|---|---|
| `pase_uid` | 36 bytes | sin TTL | OK |
| `pase_inbox_read` | **crece linealmente** sin GC | 🟡 sin TTL | **medio**: cada notif id leída se persiste para siempre. Estimado 6 meses: ~10 KB. 5 años: 100 KB. No es crítico pero es deuda. |
| `pase_local_activo` (en ErrorBoundary) | 4 bytes | manual | OK |
| `pase_theme` | 8 bytes | sin TTL | OK |
| `pase_onboarding_seen_<userId>` | 100-500 bytes | sin TTL | OK |
| `pase_print_bridge_url` | 80 bytes | sin TTL | OK |
| `pase_ajustes` | ~100 bytes | sin TTL | OK |
| `pase-mp-periodo` | ~10 bytes | sin TTL | OK |

**0 datos sensibles** (tokens, passwords, JWT crudo) en localStorage/sessionStorage de PASE. ✅. El JWT lo guarda Supabase en `sb-pduxydviqiaxfqnshhdc-auth-token` (localStorage) — gestionado por la lib, no por nosotros.

### 4.4 COMANDA
| Key | Donde | TTL | Riesgo |
|---|---|---|---|
| `comanda-items-cache` | sessionStorage | 60s | ✅ corto, invalidación correcta |
| `rol_pos_permisos_<rol>` | sessionStorage | 1h | ✅ |
| `pase_user` | sessionStorage | sesión | leído (no escrito) por `cuponesService.ts:127` para validar tenant. OK. |
| `comanda-pos-empleado` (SS_KEY) | sessionStorage | sesión | empleado POS autenticado por PIN |
| `comanda-tel-<id>` / `reserva-tel-<id>` | sessionStorage | sesión | teléfono cliente de checkout — limpiado por TTL nativo del session |
| `comanda-carrito-*` | sessionStorage | sesión | carrito tienda |
| `comanda-local-activo` | localStorage | sin TTL | local activo POS |
| `comanda.ff.<feature>` | localStorage | sin TTL | feature flags client-side |
| `comanda-notifier-mute` | localStorage | sin TTL | preferencia mute |
| `comanda-banner-mozo-shown` | sessionStorage | sesión | onboarding banner |
| `comanda-theme` | localStorage | sin TTL | OK |

**0 datos sensibles en localStorage/sessionStorage de COMANDA**. ✅.

### 4.5 IndexedDB (COMANDA solamente)
**Dos bases distintas en el mismo origin:**

**A) `comanda-offline` (v1, 7 stores) — cache stale-while-revalidate**

Definido en `lib/offlineCache.ts`. Stores: `items`, `grupos`, `mesas`, `empleados`, `canales`, `modificadores`, `lista_precios`.
- Política eviction: ninguna — entries con `Date.now() - cached_at > 24h` se consideran stale y `cacheGet` retorna null, pero **NO se borran del store**. Crecimiento sin cota.
- 7 caches por user, cada uno con N entries (1 por filter combination usado). En un dueño que entra a Items con varios filtros, puede haber 20+ entries acumulados.
- Limpieza solo manual via `cacheClear(store)` — invocada solo desde logout flow (no verifiqué si está siempre llamada).

🟡 **Hallazgo:** caches huérfanos. Sugerencia: agregar GC al abrir DB que borre entries con cached_at > 7d.

**B) `comanda-local` (v1, 10 stores) — sync engine offline-first**

Definido en `lib/db/migrations.ts`. Stores: `items`, `item_grupos`, `mesas`, `canales`, `empleados`, `ventas_pos`, `ventas_pos_items`, `ventas_pos_pagos`, `sync_meta`, `pending_ops`, `sync_conflicts`.
- Política eviction: `pullInitialAll` borra-y-reinserta TODO el contenido de cada store al login POS. ✅ buen reset por turno.
- `pullVentasAbiertas` borra TODAS las ventas del local antes de reinsertar las abiertas — riesgo: ventas cobradas locales sin sincronizar se borrarían si no estuvieran ya sincronizadas. El comentario lo admite: *"Para keep-simple acá borramos todas las del local y reinsertamos solo las abiertas. Las cobradas locales se reescriben con su estado correcto en pull incremental"*. Ventana de leak posible: cobrada local → pull initial corre → ventana entre pull y push → sobrescribe. 🟡 deuda offline-first ya conocida (Sprint A2 PASE memoria).
- `sync_conflicts` y `pending_ops` solo crecen — `pending_ops` los marca `synced`/`failed` pero no los borra. Se acumulan indefinidamente. Limpieza: ninguna. 🟡 deuda.

### 4.6 Sync engine — manejo de conflictos

`lib/sync/conflictResolver.ts` implementa LWW con excepciones para ventas finalizadas (`cobrada`/`anulada` no se sobrescriben). ✅ bien diseñado en concepto.

**Issues encontrados:**
1. `applyCloudRow` logea conflictos en `sync_conflicts` pero **no hay UI implementada que liste y resuelva los `manual_pending`**. `listPendingConflicts()` existe pero ningún componente lo consume (grep `listPendingConflicts` returns 1 match = solo la def). Conflictos quedan ahí sin que nadie los vea. 🟡 deuda.
2. `resolveLWW` usa `local.updated_at > cloud.updated_at` con clock skew local — si el reloj del POS está adelantado 5min, todos los cambios locales "ganan" aunque el cloud sea más reciente. Mitigación trivial: en `pushQueue.ts` reemplazar `updated_at` por timestamp del server al sincronizar. 🟡.

---

## 5. Refetch en cascada

### 5.1 `Caja.tsx`
- Parent `Caja` carga `load()` → 4 queries (movimientos paged + saldos + count futuros + count exact).
- Hijo `CajaCardsRow` recibe `cards` derivada de `saldos`. ✅ pre-fetch desde parent, sin fetch propio.
- Hijo `ConciliacionMP` cargado vía lazy + Suspense — fetch propio cuando sub-section cambia. ✅.

🔴 **Patrón problemático:** los 2 `useRealtimeTable` (movimientos + saldos_caja) cada uno dispara `load()` completo independientemente. En un rush de POS:
1. POS cobra efectivo → INSERT en `movimientos` → trigger crea row en `saldos_caja`.
2. Dueño con Caja abierto recibe **2 eventos Realtime** (uno por tabla).
3. Cada uno triggea `fireDebounced()` 500ms.
4. Resultado: 1 reload (los dos hooks comparten el mismo debounceTimer de tiempo similar, no se mergean — son 2 instancias del hook).

**Fix:** combinar los 2 hooks en uno solo o usar un debounce compartido a nivel componente:
```diff
- useRealtimeTable({ table: 'movimientos', onChange: () => load() });
- useRealtimeTable({ table: 'saldos_caja', onChange: () => load() });
+ const debouncedLoad = useDebouncedCallback(load, 1000);
+ useRealtimeTable({ table: 'movimientos', onChange: debouncedLoad });
+ useRealtimeTable({ table: 'saldos_caja', onChange: debouncedLoad });
```

### 5.2 `Compras.tsx`
- 3 `useRealtimeTable` independientes con mismo `onChange: () => load()` — cada cambio en facturas / remitos / proveedores triggea 4 queries (facturas + remitos + proveedores + nc_aplicaciones). Mismo patrón problemático.
- Mejor: 1 hook con `enabled` o el merge anterior.

### 5.3 `useBandejaEntrada` (PASE) — 🔴 caso más grave
- 3 subscripciones distintas, cada una dispara `reload()` (no debounced extra).
- `reload()` lanza `Promise.all` de **6 queries** en paralelo.
- Si en un rush hay 3 cambios consecutivos (1 tarea + 1 override + 1 solicitud), son **18 queries** en ~1 segundo (3 × 6).
- El user ni siquiera necesita esa data — solo necesita re-contar para la campanita.

**Fix:** las 3 subs deberían disparar un único `debouncedReload`, no `reload` directo:
```diff
+ const debouncedReload = useDebouncedCallback(reload, 1500);
- useRealtimeTable({ table: "dashboard_pinned_notes", onChange: reload, ... });
- useRealtimeTable({ table: "manager_override_usos", onChange: reload, ... });
- useRealtimeTable({ table: "manager_solicitudes", onChange: reload, ... });
+ useRealtimeTable({ table: "dashboard_pinned_notes", onChange: debouncedReload, ... });
+ useRealtimeTable({ table: "manager_override_usos", onChange: debouncedReload, ... });
+ useRealtimeTable({ table: "manager_solicitudes", onChange: debouncedReload, ... });
```
Ahorro estimado: 60-80% de queries en rush.

---

## 6. Subscriptions sin scope

✅ **0 instancias de `db.channel('*')` o subscripciones sin filter.**

- `useRealtimeTable` aplica `tenant_id=eq.${tenantId}` por default (`scopeByTenant=true`) en TODOS los hooks que lo invocan sin opt-out explícito.
- 19 de 26 hooks COMANDA agregan también `local_id=eq.${localId}`.
- `extraFilter` se usa correctamente en 5 hooks COMANDA para filtros adicionales.

**Único caso "peligroso":** `useBandejaEntrada` los 3 hooks scopean por tenant pero NO por local — un encargado de Local A recibe eventos Realtime de cambios en facturas/manager_solicitudes del Local B (mismo tenant). Bajo impacto: solo invalida cache de su propia bandeja (que ya filtra cross-local intencionalmente).

---

## 7. React rerenders excesivos

### 7.1 Ausencia de `React.memo`
🟠 **0 usos de `React.memo` o `memo()` en `packages/pase/src` ni `packages/comanda/src`.**

Components grandes que reciben props de listas:
- `CajaCardsRow` recibe `cards: CajaCardSpec[]` — referencialmente cambia cada `load()`.
- Cualquier `Row` component dentro de `<table>` en Caja/Compras/Reportes — se re-renderiza completo cada vez que el padre re-fetcha.
- `ComandasActivasPanel` lista `ventas.map(...)` sin memo de items individuales.

Combinado con #1/#3 (reloads en rush) → jank visible. **Estimado:** un dueño con Caja abierto durante hora pico ve ~10-15 re-renders/segundo de la tabla de movimientos (cada uno con N rows).

### 7.2 Tick de re-render forzado
- `CodigosManager` setInterval 1s → setState → re-render del árbol completo cada segundo, aunque el componente solo necesita un span con el countdown.
- `KdsView` setInterval 30s para reloj + 30s tickCounter → 2 re-renders cada 30s (podría ser 1).
- `SalonView` setInterval 30s tick — re-renderiza grid de mesas.

**Fix patrón:** aislar el contador a un componente hijo memoizado:
```tsx
const Countdown = memo(({ from }: { from: number }) => {
  const [secs, setSecs] = useState(from);
  useEffect(() => { /* tick */ }, []);
  return <span>{secs}s</span>;
});
```

### 7.3 Console.log instrumentation
`ConciliacionMP.tsx` tiene `console.log` y `console.groupCollapsed` en hot path (sincronizar/load). Bajo impacto en perf real pero costoso en devtools abierto.

---

## 8. Instancias `createClient` Supabase — limpieza

```
packages\admin-console\src\lib\supabase.ts:18     export const db = createClient(...)
packages\comanda\src\lib\supabase.ts:16           export const db = createClient(...)
packages\comanda\src\lib\supabaseAnon.ts:19       export const dbAnon = createClient(...) // anon-no-session
packages\pase\src\lib\supabase.ts:20              export const db = createClient(...)
```

✅ **Limpio.** 1 cliente por package + 1 cliente anon-no-session intencional en COMANDA para flujos públicos (tienda, KDS, menú QR) que no deben pisar la sesión del user logueado.

- 0 `createClient` repetidos en components.
- 0 hooks/services crean clientes propios.
- El singleton se importa correctamente como `db` (PASE/admin-console/COMANDA principal) o `dbAnon` (COMANDA público).

---

## 9. Findings priorizados — antes/después

### 🔴 ALTO-1: Bandeja de Entrada fan-out de 6 queries en cascada
**File:** `packages/pase/src/lib/useBandejaEntrada.ts:267-291`

**Antes:**
```ts
const reload = useCallback(async () => {
  // ... Promise.all de 6 fetchers
}, [user]);

useEffect(() => { void reload(); }, [user?.id, user?.rol]);
useRealtimeTable({ table: "dashboard_pinned_notes", onChange: reload, ... });
useRealtimeTable({ table: "manager_override_usos", onChange: reload, ... });
useRealtimeTable({ table: "manager_solicitudes", onChange: reload, ... });
```

**Después:**
```ts
const reload = useCallback(async () => { /* idem */ }, [user]);
// Debounce a nivel componente: las 3 subs disparan a la misma fn, que coalesce
// en 1.5s. En un rush con 3 cambios consecutivos, se hace 1 reload en vez de 3.
const debouncedReload = useDebouncedCallback(reload, 1500);

useEffect(() => { void reload(); }, [user?.id, user?.rol]);
useRealtimeTable({ table: "dashboard_pinned_notes", onChange: debouncedReload, ... });
useRealtimeTable({ table: "manager_override_usos", onChange: debouncedReload, ... });
useRealtimeTable({ table: "manager_solicitudes", onChange: debouncedReload, ... });
```
**Ahorro estimado:** 60-80% queries en rush para users con bandeja activa.

### 🔴 ALTO-3: Caja.tsx — 2 hooks reload independientes en cascada
**File:** `packages/pase/src/pages/Caja.tsx:346-347`

**Antes:**
```ts
useRealtimeTable({ table: 'movimientos', onChange: () => load() });
useRealtimeTable({ table: 'saldos_caja', onChange: () => load() });
```

**Después:** 1 debounce compartido + colapsa los dos events trigger-driven en 1 reload.
```ts
const debouncedLoad = useDebouncedCallback(load, 1000);
useRealtimeTable({ table: 'movimientos', onChange: debouncedLoad });
useRealtimeTable({ table: 'saldos_caja', onChange: debouncedLoad });
```
**Ahorro:** 50% queries en flow estándar (efectivo registra mov + trigger crea saldo = 2 eventos → 1 reload).

### 🟠 ALTO-2: Catálogos con Realtime + sessionStorage TTL — redundancia
**Files:** `packages/pase/src/lib/{useCategorias,useMediosCobro,usePuestosRRHH}.ts`

**Antes:** cache 1h sessionStorage + sub Realtime permanente sobre tabla que cambia 1 vez/mes.

**Opciones:**
- A) **Cheap:** subir TTL a 24h y mantener Realtime (3 channels gastados pero queries del cache cuando vence más espaciadas).
- B) **Mejor:** eliminar Realtime sub, agregar `BroadcastChannel` cross-tab + invalidación on-focus si TTL vencido.
- C) **Más invasivo:** un único `useTenantCatalogs()` hook centralizado que mantenga UNA suscripción al evento "config cambió" en lugar de 3 channels.

**Ahorro:** 3 channels permanentes/user → 0 channels (opción B).

### 🟠 ALTO-4: Polling sin visibility-aware
**Files:** `packages/comanda/src/lib/sync/syncEngine.ts:97`, `useOnlineStatus.ts:55`, `components/BusyModeButton.tsx:54`, `pages/Hardware/Hardware{Riders,Agentes}.tsx`

**Antes:**
```ts
this.intervalId = setInterval(() => { void this.runFullCycle(false); }, 30_000);
```

**Después:** chequeo de visibility dentro del callback (no requiere refactor a hook):
```ts
this.intervalId = setInterval(() => {
  if (document.visibilityState === 'hidden') return;
  void this.runFullCycle(false);
}, 30_000);
```
**Ahorro:** 0 queries cuando POS minimizado / tab cambiada. En un local con 5 terminales abiertas pero 2 sin uso activo, son ~14400 queries/día evitadas.

### 🟡 MEDIO-5: ManagerOverrideModal polling RPC cada 3s
**File:** `packages/pase/src/components/ManagerOverrideModal.tsx:123-131`

**Antes:** polling de `fn_consultar_solicitud(p_id)` cada 3s, hasta 300 RPCs si solicitud expira sin respuesta.

**Después:** Realtime sobre `manager_solicitudes` filtrado por id:
```ts
useRealtimeTable({
  table: 'manager_solicitudes',
  extraFilter: `id=eq.${estado.solicitudId}`,
  enabled: estado.tipo === 'esperando',
  onChange: () => consultarSolicitud(estado.solicitudId),
});
```
**Ahorro:** de 300 RPCs/15min → 1 RPC inicial + 1 por cambio real (típicamente 1-2).

### 🟠 ALTO-7: 0 `React.memo` en components grandes
**Files:** TODOS los components con `<tr>` o list-items dentro de listas grandes (Caja, Compras, Reportes, etc.)

**Antes:**
```tsx
function MovimientoRow({ m, onEdit }: Props) { /* lots of JSX */ }
```

**Después:**
```tsx
const MovimientoRow = memo(function MovimientoRow({ m, onEdit }: Props) {
  /* idem */
}, (prev, next) => prev.m.id === next.m.id && prev.m.updated_at === next.m.updated_at);
```
**Ahorro estimado en Caja con 80 movimientos:** de ~80 re-renders por reload → ~1-2 (solo el row que cambió). Cuello de botella principal del jank percibido.

### 🟠 ALTO-15: Realtime sin merge incremental (arquitectónico)
**File:** `packages/pase/src/lib/useRealtimeTable.ts` (y COMANDA)

**Antes:** firma actual `onChange: () => void` descarta el payload.

**Después:** versión backward-compatible que expone el row al caller:
```ts
interface UseRealtimeTableOptions<T = unknown> {
  // ...
  onChange?: () => void;             // legacy mode — full reload
  onUpsert?: (row: T) => void;       // new mode — merge incremental
  onDelete?: (id: number | string) => void;
}
```
Migración progresiva: hooks pesados (Caja, Compras, Reportes/Dashboard) migran a onUpsert; resto sigue con onChange. **Ahorro proyectado:** -80% egress Realtime largo plazo.

---

## 10. Lo que está bien — para mantener

- **`useRealtimeTable` hook bien diseñado**: tenant scope automático, fallback a polling con backoff, visibility-aware, cleanup correcto, debounce coalescente, helper `buildRealtimeConfig` testeable.
- **`useVisiblePolling` (COMANDA)**: ya cubre el caso happy path — más migraciones a este helper son trivialmente seguras.
- **`offlineCache` (COMANDA)**: pattern stale-while-revalidate bien implementado con TTL 24h y fallback transparente.
- **Sync engine COMANDA**: arquitectura sólida (pull initial + incremental + push queue + LWW con audit) — el problema es operativo (sin pause-on-hidden, conflictos sin UI, GC ausente), no de diseño.
- **0 datos sensibles** en localStorage/sessionStorage — el JWT lo maneja la lib Supabase, no nosotros.
- **0 createClient redundantes** — singleton por package.
- **scopeByTenant default true** previene el footgun de Realtime cross-tenant.
- **Idempotency keys (Compras)** persistidos en sessionStorage para recovery de browser muerto a mitad — patrón sunny-creek C1+C10 bien aplicado.

---

## 11. Para la próxima fase (4 — Frontend PASE)

Quedaron para auditoría detallada de frontend:
- **React.memo audit completo**: identificar TOP 10 components que más se re-renderizan y memoizar.
- **Code splitting**: chunks por ruta (algunos lazy ya existen — verificar cobertura `pages/Caja/CajaCardsRow` y similares).
- **Bundle size**: tracking del bundle prod después de los memos.
- **Diff handler para Realtime**: implementar `onUpsert/onDelete` en `useRealtimeTable` y migrar las 3 pantallas más caras (Caja, Compras, Reportes/Dashboard).

Pendiente decisión:
- **Sync engine COMANDA pause-on-hidden** y **GC de `sync_conflicts` + `pending_ops`** — modifica comportamiento offline; conversar antes de tocar.
- **UI de conflictos pendientes** (listPendingConflicts no se consume) — feature faltante, no bug.

---

**Reportes relacionados:**
- [01-bugs-financieros.md](./01-bugs-financieros.md) — bugs Caja/Compras a nivel datos.
- [02d-auth-sessions.md](./02d-auth-sessions.md) — cache `pase_user` permissions stale documentado allí.
- [03a/03b — pendientes]: queries lentas DB-side + bundle JS.
