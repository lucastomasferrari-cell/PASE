# Fase 4C — Hooks + utilidades de `src/lib/` y `src/hooks/`

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Scope:** `packages/pase/src/lib/*.ts` (35 archivos) + `packages/pase/src/lib/{calculos,maxirest,services}/*` (6 archivos) + `packages/pase/src/hooks/*` (3 archivos).
**Método:** lectura estática de cada archivo, grep dirigido (`any`, `console.*`, `.toISOString`, `new Date()`, `.toFixed(2)`, importaciones de cada helper/hook), cruce de definiciones vs consumidores.

---

## 📊 Resumen ejecutivo

| Métrica | Valor | Comentario |
|---|---|---|
| Archivos en `src/lib/` (TS) | **35** + 6 en subcarpetas | Mezcla de hooks (10), utils puros (10), parsers (5), services (2), feature catalogs (3), helpers de browser (5). |
| Hooks en `src/hooks/` | **3** | `useFinanzas.ts`, `useNegocio.ts` (mocks orfanos), `useToast.ts`. |
| Hooks reales en `src/lib/` | **8** | useRealtimeTable, useCategorias, useMediosCobro, usePuestosRRHH, useBandejaEntrada, useTenantFeatures, useDebouncedValue, useGuardedHandler, useLocalContextoUI. |
| Tests totales en `src/` | **16** archivos `.test.ts` | 14 en `src/lib/`, 1 en `lib/calculos/`, 1 en `lib/maxirest/`. **0 tests para componentes/pages.** |
| Hooks sin test | **6 de 8 hooks** | Solo `useCategorias` y `useMediosCobro` tienen test paralelo — y en `useCategorias.test.ts` la función testeada está **duplicada inline** porque `fromRows` no se exporta. |
| Utils sin test | **17 de 35** | Sin test: `auth.ts` (PARCIAL — solo necesitaElegirLocal), `features.ts`, `onboardingProgress.ts`, `onboardingTours.ts`, `push.ts`, `printESCPOS.ts`, `notification-types.ts`, `chunkLoadErrorHandler.ts`, `consoleCapture.ts`, `comanda-sso.ts`, `exportCSV.ts`, `sidebar-nav.ts` (parcial), todos los `use*.ts` hooks excepto los dos arriba, calculos/rrhh ✓, maxirest/parser ✓, saldoMP ✓, saldoProveedor ✓, utils ✓, format ✓, errors ✓, parseCSV ✓, parseMonto ✓, mpExtractoParser ✓, _mp-csv ✓. |
| Archivos con `: any` / `as any` / `<any>` | **0** | TS strict está limpio. Solo aparecen `unknown` (18 ocurrencias en 10 archivos), correctamente acotados. |
| Archivos completamente **muertos** (sin un solo consumidor) | **4** | `hooks/useFinanzas.ts` (6.4 KB mock orfan), `hooks/useNegocio.ts` (6.3 KB mock orfan), `lib/saldoMP.ts` (3.5 KB) + `saldoMP.test.ts` (4.5 KB), `lib/services/{caja,rrhh}.service.ts` (0 consumidores excepto sí mismos). |
| `console.log` que quedaron en `src/lib/` | **0** | Bien. Hay 12 en pages (`ConciliacionMP.tsx`: 10, `Usuarios.tsx`: 2). |
| `console.error` total en `src/` | **29** en 13 archivos | Sin un sink `logError` que mande a backend — todo se queda en DevTools del browser. Solo `consoleCapture.ts` los guarda en memoria para SoporteWidget. |
| `console.warn` en `src/lib/` (fallbacks) | **6** ocurrencias | useCategorias×2, useMediosCobro×2, usePuestosRRHH×2 — patrón consistente: "X usando FALLBACK por …". |
| `.toISOString()` en `src/` | **57** en 26 archivos | **Mayoría sin TZ** — `new Date().toISOString().slice(0,10)` para "hoy" devuelve UTC, no Buenos Aires. Banderazo: cerca de medianoche AR un user puede ver "hoy" desfasado. |
| `new Date()` en `src/lib/` | **14** | 4 son legítimos (consoleCapture timestamps, calculos/rrhh con `ahora` inyectable, useBandejaEntrada el now de notificación). El resto en useBandejaEntrada deriva en `.toISOString()`. |
| Helper centralizado para money math | **NINGUNO** | Hay `fmt_$`, `formatCurrency`, `fmt_money` (3 aliases del mismo formato) pero **ningún `sumMoney`, `subtractMoney`, `multiplyMoney`** — todo se hace inline con `+` / `-` / `*` sobre `number` JS. Sin redondeo controlado. |
| `.toFixed(2)` "suelto" | **16** ocurrencias en 11 archivos | Algunos son legítimos (impresión ESC/POS, CSV export, mostrar 2 decimales de stock). Pero hay casos como `LectorExtractoMP.tsx:239,247` que usa `Number(monto).toFixed(2)` para construir una **clave de dedup** — propenso a `9.999999999.toFixed(2) === "10.00"` y match falso. |
| **Side-effects en módulos** | **2** críticos + 1 menor | `utils.ts:32` `export const today = new Date()` (frozen al primer import — usado por 16 pages), `chunkLoadErrorHandler.ts` instala listeners globales al llamar `install*()` (OK, es explícito), `consoleCapture.ts` patch a `console.error` al llamar `init*()` (OK, explícito). |
| Default exports vs named | **0 default exports** | Convención `export function` limpia y consistente en todo `src/lib/`. |
| Services con escrituras directas violando C4 | **1** (`caja.service.ts`) | Marcadas con `eslint-disable -- deuda C4-F11` (líneas 27, 36). Hay 0 consumidores — el archivo está muerto. **Acción:** borrar el service en vez de cerrar la deuda. |

---

## 🚦 Tabla ranking por severidad

| # | Hallazgo | Archivo | Severidad |
|---|---|---|---|
| 1 | `useFinanzas.ts` + `useNegocio.ts` son **mocks sin consumidor** — 12.9 KB de código muerto que se distribuye al bundle si algún día alguien los importa | `src/hooks/` | 🟠 ALTO |
| 2 | `services/caja.service.ts` + `services/rrhh.service.ts` sin consumidor — incluyen **escritura directa a `movimientos` y `saldos_caja` con read-then-write race condition** (line 32-39), marcadas como deuda C4-F11 | `src/lib/services/` | 🔴 ALTO (si se llegan a usar) / 🟡 (porque están muertos) |
| 3 | `lib/saldoMP.ts` + `saldoMP.test.ts` sin consumidor en pages — 8 KB de código + tests muertos | `src/lib/saldoMP.ts` | 🟠 MEDIO |
| 4 | `utils.ts:32` `export const today = new Date()` — **valor frozen al primer import** del módulo. Si el browser queda abierto 1 día, `today` sigue siendo el de ayer | `src/lib/utils.ts:32` | 🔴 ALTO |
| 5 | Sin helper de money math (sum/sub/mult). Todo el repo hace `+`, `-`, `*` sobre `number` JS, sin redondeo consistente. Riesgo: `0.1 + 0.2 === 0.30000000000000004`. Combinado con `.toFixed(2)` ad-hoc en 11 archivos genera diffs no determinísticos | (cross-cutting) | 🟠 ALTO |
| 6 | **0 tests para hooks React** (todos los `use*.ts`). `useCategorias.test.ts` testea una **copia inline** de `fromRows` porque la real no se exporta — el test pasa pero **no testea el hook**. Idem useMediosCobro (testea `pickDisponibles` / `pickCuentaDestino` que sí están exportados, OK ahí). | `src/lib/use*.ts` | 🟠 ALTO |
| 7 | `console.error` se queda en DevTools — **no hay `logError` que mande al backend**. 29 ocurrencias en 13 archivos. ErrorBoundary (`components/ErrorBoundary.tsx:47-48`) hace `console.error` y nada más. Sentry/Vercel logs nunca ven el crash | (cross-cutting) | 🟠 ALTO |
| 8 | `.toISOString().slice(0,10)` para "hoy" en `useBandejaEntrada.ts:139,168` y otros — **da el día UTC, no Buenos Aires**. Cerca de medianoche AR un user ve "ayer" o "mañana" en bandeja | `src/lib/useBandejaEntrada.ts:139,168` + 57 ocurrencias más | 🟠 ALTO |
| 9 | `useCategorias.ts:181` la función `refresh` se declara **antes** de `setState` y eso requiere 2 eslint-disable + comentarios largos. La inversión natural sería `useState → useCallback`. Bug latente: si se reordena para limpiar el lint, el `setState(s => ...)` del initialState pasa `s.refresh` que no existe en el primer render | `src/lib/useCategorias.ts:181-213` | 🟡 MEDIO |
| 10 | `useBandejaEntrada.ts:283-288` mezcla 6 fetchers + merge en single `setState` — sin `useMemo` ni `useReducer`. Cualquier cambio en `notifs` re-render todo el árbol del topbar (sin React.memo, ver F3C #7) | `src/lib/useBandejaEntrada.ts:283` | 🟡 MEDIO |
| 11 | `useToast.ts:17` `setTimeout` dentro de `showToast` **no se cancela en unmount** — si el componente se desmonta antes del `duration`, el callback dispara `setToast(t => …)` en componente desmontado (warning React 19). El check `t.message === message` lo mitiga pero no lo evita | `src/hooks/useToast.ts:17` | 🟡 MEDIO |
| 12 | `errors.ts` `MAP` (155 códigos) está completo pero **algunas duplicaciones legacy**: `LINEAS_REQUERIDAS` + `LINEAS_REQUIRED`, `TURNO_REQUERIDO` + `TURNO_REQUIRED`, `FECHA_REQUERIDA` + `FECHA_REQUIRED`, `LOCAL_REQUERIDO` + `LOCAL_REQUIRED` (líneas 58-64). Sugiere RPCs inconsistentes en backend — vale unificar lado SQL | `src/lib/errors.ts:58-64` | 🟡 MEDIO |
| 13 | `useGuardedHandler.ts` sin test — es **infraestructura anti-doble-click** que se usa en pagos. Vale 1 test (mock fn, doble call, verificar 1 sola invocación). | `src/lib/useGuardedHandler.ts` | 🟡 MEDIO |
| 14 | `LectorExtractoMP.tsx:239,247` usa `Number(monto).toFixed(2)` como **clave de dedup** — colisión potencial con floats imprecisos | `src/pages/LectorExtractoMP.tsx:239,247` | 🟡 MEDIO |
| 15 | `useTenantFeatures.ts` **no tiene fallback offline** ni hook Realtime. Si superadmin toggle una feature, el user actual ve cache de 5 min antes de captar el cambio. Comparar contra useCategorias que sí usa Realtime + sessionStorage | `src/lib/useTenantFeatures.ts` | 🟡 MEDIO |
| 16 | `format.ts` exporta `formatCurrency` + `formatCurrencyCompact` + `formatDelta` + alias `fmt_money = formatCurrency`. **Pero** `utils.ts` también exporta `fmt_$` que hace lo mismo. Pages usan inconsistentemente uno u otro (`fmt_$` en 16 pages, `formatCurrency` en 8 archivos). Convergir a uno solo | `src/lib/{utils,format}.ts` | 🟡 MEDIO |
| 17 | Hooks de catálogo (`useCategorias`, `useMediosCobro`, `usePuestosRRHH`) usan **3 implementaciones casi idénticas** del patrón cache+fallback+realtime (~150 LOC c/u). Vale extraer un `useCachedCatalog<T>({ table, ttl, fallback })` | (refactor) | 🟢 BAJO |
| 18 | `printESCPOS.ts` (10 KB) y `exportCSV.ts` (2 KB) sin test. ESC/POS es razonable (depende de bridge), pero `exportCSV` es 100% pura y testable en 5 min | `src/lib/{printESCPOS,exportCSV}.ts` | 🟢 BAJO |
| 19 | `notification-types.ts` exporta `NOTIFICATION_TYPES` array + `NOTIFICATION_GROUPS` + helper `getNotificationType` — 1 solo consumidor (`ConfiguracionNotificaciones.tsx`). Razonable como **catálogo configurable** pero el helper agrega indirección sobre `.find()` directo | `src/lib/notification-types.ts` | 🟢 BAJO |
| 20 | `onboardingTours.ts` (17 KB, 528 líneas) — no auditado en profundidad, vive aparte del flow de wizard. Vale revisar separado si se cierra alguna deuda de onboarding | `src/lib/onboardingTours.ts` | 🟢 BAJO |

**Para atacar primero:** #1 + #2 + #3 (borrar 4 archivos muertos = limpieza de 22 KB). #4 (`today` frozen) tiene impacto real en producción cualquier user que tenga la pestaña abierta a medianoche. #5 (money math sin helper) + #7 (sin `logError`) son los dos cambios de plataforma que más pagan a largo plazo.

---

## 1. Hooks — auditoría individual

### 1.1 `useRealtimeTable.ts` (7.3 KB)
**Cobertura ya hecha en F3C #3, #4, #15.** Patrón sólido (debounce 500ms, visibility-aware, fallback polling 30s, cleanup correcto). Documentación JSDoc al inicio. Sin tests para el hook completo, sí para el helper puro `buildRealtimeConfig` (vía `useCategorias.test.ts` y otros). **Único pendiente nuevo:** el `events.join(",")` como dep estabiliza pero genera comparación de string en cada render — micro, no crítico.

### 1.2 `useCategorias.ts` (11.5 KB)
**Patrón cache+fallback+realtime.** Bien documentado. Issues:
- **L181-213:** `refresh` se declara antes de `useState` con eslint-disable. Si se invierte el orden, `setState(s => ({ ...s, refresh: s.refresh }))` rompe (`s.refresh` no existe inicialmente). Vale refactor a `useReducer` o ref para `refresh` estable.
- **L251:** sub Realtime permanente sobre catálogo que cambia 1 vez/mes — ver F3C #2 (gasto innecesario, mejor invalidate-on-focus).
- **Test:** duplica `fromRows` inline en lugar de exportarlo. El test pasa pero **no testea el hook real**.

### 1.3 `useMediosCobro.ts` (7.5 KB)
Mejor diseñado que `useCategorias`: exporta `pickDisponibles` y `pickCuentaDestino` puros que son los que testea. Resolution local-specific > global está documentada y testeada. Mismo problema de Realtime permanente sobre catálogo estable.

### 1.4 `usePuestosRRHH.ts` (3.9 KB)
Estructura idéntica a `useMediosCobro` pero **sin separar helpers puros para testear**. Sin tests propios. Patrón de 3 hooks casi idéntico — ver finding #17.

### 1.5 `useBandejaEntrada.ts` (13.4 KB)
**Cobertura ya hecha en F3C #1, #11.** Findings nuevos:
- **L139, 168, 233:** `new Date().toISOString().slice(0,10)` — bug TZ. En la query `fetchFacturasVencidas`, `hoyIso < venc` puede dar resultado distinto a las 23:30 AR (UTC ya pasó al día siguiente).
- **L283-288:** merge de 6 fetchers en un solo `setNotifs`. Sin memoization. Combina mal con re-render fan-out del topbar.
- **L317:** `countNoLeidas` re-computado cada render — `useMemo` lo soluciona.

### 1.6 `useTenantFeatures.ts` (3.6 KB)
**Sin Realtime ni fallback.** Cache `sessionStorage` 5 min. Si superadmin cambia features, el user actual tiene cache stale hasta 5 min. Falta paridad con `useCategorias`. Sin tests.

### 1.7 `useDebouncedValue.ts` (1 KB)
**Limpio, testable trivialmente (no tiene test).** Convención C6 declarada. Cleanup correcto en effect. Bien.

### 1.8 `useGuardedHandler.ts` (1.9 KB)
**Sin test.** Crítico para anti-doble-click en pagos — debería tener al menos un test que verifique que un `await` lento no permite re-entrada.

### 1.9 `useLocalContextoUI.ts` (4.9 KB)
Documentación JSDoc extensa y clara (modos "vista" / "carga"). Sin tests. Tiene `setState in effect` con eslint-disable + comentario justificado. Single consumer (`components/ui/LocalContextoUI.tsx`).

### 1.10 `src/hooks/useFinanzas.ts` (6.4 KB) — **MOCK ORFAN**
```ts
// Por ahora retornan data MOCK realista (gastronomía argentina tipo Neko).
// La segunda iteración conectará a: …
```
Exporta `useFinanzasConsolidado`, `useLocalFinanzas`, `useVencimientos`. **0 consumidores en `src/pages/`.** Solo se referencia a sí mismo. Bandera roja: si alguien lo importa por nombre tipo "FinanzasConsolidado" termina con UI mostrando $1.240.000 hardcoded de mock.

### 1.11 `src/hooks/useNegocio.ts` (6.3 KB) — **MOCK ORFAN**
Idem useFinanzas. `useNegocioConsolidado`, `useObjetivos`. **0 consumidores reales** (solo grep matches dentro del mismo archivo).

### 1.12 `src/hooks/useToast.ts` (0.9 KB)
6 consumidores (RRHH, Ventas, Gastos, ConciliacionMP, RolesPermisos, RRHHLegajo). **L17:** `setTimeout` sin cleanup — si el componente desmonta antes del `duration`, dispara setState en componente muerto:
```ts
setTimeout(() => setToast(t => t && t.message === message ? null : t), duration);
```
React 19 lo loguea como warning silencioso. Fix: ref + clearTimeout en `useEffect` cleanup.

---

## 2. Utilidades puras en `src/lib/`

### 2.1 `utils.ts` (3.8 KB) — fmt_$, fmt_d, parseMonto, toISO, today, fmt_dt_ar, fmt_t_ar
**Bug latente — L32:** `export const today = new Date()` se evalúa al **primer import** del módulo. Como Vite/React mantiene módulos vivos toda la sesión, una pestaña abierta a las 23:55 AR seguirá viendo `today.toISOString()` correspondiente al día anterior 18+ horas después. Consumido por 16 pages que típicamente lo usan para defaults de filtro de fecha (`estadoFactura(f, toISO(today))`). **Fix:** convertir a getter (`export const today = () => new Date()`) y actualizar consumidores, o exportar solo `toISO(new Date())` cuando se necesite.

Convención TZ AR (`toBuenosAires`, `fmt_dt_ar`, `fmt_t_ar`) está bien definida — el problema es que existe pero los pages siguen usando `.toISOString()` crudo. **57 ocurrencias en 26 archivos** ignoran el patrón.

### 2.2 `format.ts` (3.1 KB) — formatCurrency, formatCurrencyCompact, formatDelta, fmt_money
**Convive con `utils.ts::fmt_$`** que hace lo mismo. Decisión histórica: `fmt_$` usa `Intl.NumberFormat` con regex post-replace; `formatCurrency` usa `toLocaleString` directo. Salida idéntica pero código duplicado y consumidores divididos. **Convergir a uno** (sugerencia: deprecar `fmt_$`, dejar `formatCurrency` que es más simple).

### 2.3 `errors.ts` (10.9 KB) — translateRpcError
**Bien diseñado.** Map de 155 códigos + match por prefijo si la RPC anexa contexto post-`:`. Fallback transparente al raw string. **Mejorable:** códigos legacy duplicados `*_REQUERIDA` / `*_REQUIRED` (4 pares) sugieren backend inconsistente. Vale unificar.

### 2.4 `auth.ts` (17.6 KB) — Helpers de permisos + locales + AuthContext
**Bien testeado:** `auth.test.ts` cubre `tienePermiso`, `getPermisos`, `scopeLocales`, `applyLocalScope`. **Comentarios extensos** explican casos límite (encargado con cuentas vacías, fallback `cuentas_operables`, etc.). Aplicaría refactor para extraer:
- Constants `ROLES`, `PERMISOS_EXTRAS`, `MODULOS` → archivo separado (son 90 líneas de catálogo).
- Helpers de cuenta (cuentasVisibles, puedeOperarCuenta, etc.) → `lib/cuentas.ts`.

### 2.5 `constants.ts` (3.1 KB) — Fallbacks para useCategorias/useMediosCobro
**OK.** Sin tests directos (los testean los hooks que los usan como fallback). Importantes: estos arrays son **el respaldo offline** del sistema — si la DB cae, son los defaults visibles.

### 2.6 `supabase.ts` (1.1 KB) — Instancia única `db`
Limpia, single createClient. Throw explícito si falta la env var (mejor que arrancar y crashear más tarde). Sin tests (no hace sentido testear instancia singleton).

### 2.7 `features.ts` (12.8 KB) — Catálogo de feature flags
Catálogo declarativo de 31 features (Operación / Dirección / Herramientas / Integraciones / Sistema / Beta). Helpers `tenantTieneFeature`, `getFeatureDef`, `featuresPorCategoria`. **Sin tests** pero tampoco hace lógica compleja — todo es lookup sobre array. OK.

### 2.8 `sidebar-nav.ts` (6 KB) — Catálogo de items sidebar
Limpio, exportado con tipos. **Sí tiene test** (`sidebar-nav.test.ts`). `LEGACY_REDIRECTS` con sentinel `@default` está bien documentado.

### 2.9 `saldoProveedor.ts` (4 KB) — calcularSaldosPorProveedor
**Función pura, bien testeada** (`saldoProveedor.test.ts`). Documentación extensa explica fix del bug T-19 (NC parcialmente aplicada). 3 consumidores reales (Compras.tsx, ModalPagarFactura.tsx, Proveedores.tsx). Bien.

### 2.10 `saldoMP.ts` (3.5 KB) — **MUERTO**
Función pura `computeSaldoMP` + `pickEffectiveLocalId`, **con test** (`saldoMP.test.ts`, 4.5 KB). **Pero:** 0 consumidores en `src/pages/`. Vivió cuando había una card de saldo MP en el header; al sacarla, quedó huérfano. Borrar.

### 2.11 `calculos/rrhh.ts` (rrhh.ts) — Funciones puras de liquidaciones
**Excelente**. Funciones puras, sin side-effects, fecha inyectable (`ahora: Date = new Date()`), full test coverage (`rrhh.test.ts`). 4 consumidores activos. Modelo a seguir para el resto.

### 2.12 `maxirest/parser.ts` — Parser v3
Bien documentado (v3 = "filosofía nueva: leer SOLO 3 cosas"). Test paralelo. Función pura.

### 2.13 `mpExtractoParser.ts` (9.5 KB) — Parser MP CSV
Bien testeado. Usa `.toFixed(2)` para mensajes de warning (L211, 214) — OK porque es solo log.

### 2.14 `parseCSV.ts`, `parseMonto.ts`
Funciones puras, bien documentadas, con tests.

### 2.15 `exportCSV.ts` (2 KB)
Pura, sin tests. Bien documentada. Trivial agregar tests.

### 2.16 `printESCPOS.ts` (10.5 KB)
Bien estructurada (CMD bytes + render function + bridge POST). Sin tests — razonable porque depende de bridge externo, pero `render()` es pura y se podría testear con snapshots de Uint8Array.

### 2.17 `push.ts` (5.4 KB) — Web Push subscription
2 consumidores (`ConfiguracionNotificaciones.tsx`, `NotificacionesPushToggle.tsx`). Sin tests (depende de service worker + permisos browser).

### 2.18 `comanda-sso.ts` (1.3 KB)
**Re-orientado** post-eliminación del SSO bridge — ahora solo abre URL. 1 línea de lógica útil. Mantener como adapter por si vuelve SSO.

### 2.19 `consoleCapture.ts` (3.1 KB)
Captura `console.error` + `window.onerror` + `unhandledrejection` en array circular de 20. **Patch a `console.error`** ocurre al llamar `initConsoleCapture()` desde `main.tsx`. **OK** porque es explícito. Sin tests.

### 2.20 `chunkLoadErrorHandler.ts` (3.9 KB)
Handler global para "Failed to fetch dynamically imported module" post-deploy. Anti-loop con cooldown 60s en sessionStorage. Bien diseñado. Sin tests.

### 2.21 `onboardingProgress.ts` (3.2 KB)
2 helpers DB + 2 helpers puros (`calcularAvance`, `necesitaOnboarding`). Los puros son trivialmente testeables — **sin tests**.

### 2.22 `onboardingTours.ts` (17 KB)
**No auditado en profundidad** — 528 líneas de tour driver.js. Vale revisar separado.

### 2.23 `notification-types.ts` (3.8 KB)
Catálogo declarativo + 1 helper trivial. 1 consumidor. OK.

---

## 3. `src/lib/services/` — services orfanos

### 3.1 `caja.service.ts` (línea 27-39)
```ts
async insertMovimiento(mov) {
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F11: …
  const { error } = await db.from("movimientos").insert([mov]);
  if (error) throw error;
},

async actualizarSaldo(cuenta, localId, delta) {
  const { data: caja } = await db.from("saldos_caja").select("saldo")
    .eq("cuenta", cuenta).eq("local_id", localId).maybeSingle();
  if (!caja) return;
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F11: …
  const { error } = await db.from("saldos_caja")
    .update({ saldo: (caja.saldo || 0) + delta })
    .eq("cuenta", cuenta).eq("local_id", localId);
  if (error) throw error;
},
```

Esta `actualizarSaldo` tiene **race condition** (read-then-write) que viola C4. Y es **dead code** — 0 consumidores. La solución correcta es **borrar el archivo** en vez de "cerrar la deuda" implementando una RPC. Mismo caso para `rrhhService` (no viola C4 pero tampoco lo usa nadie).

---

## 4. Patterns problemáticos cross-cutting

### 4.1 Money math sin helper centralizado
- **77 ocurrencias** de `fmt_$` / `formatCurrency` / `fmt_money` (formatos).
- **0 ocurrencias** de un `sumMoney(a, b)` / `mulMoney(qty, price)` / `roundMoney(x)`.
- 16 `.toFixed(2)` ad-hoc, alguno como **dedup key** (bug latente).
- 7 `Math.round(*)` en `src/lib/` (saldoMP, useBandejaEntrada, calculos/rrhh, onboardingProgress).

**Sugerencia:** crear `src/lib/money.ts` con:
```ts
export const sumMoney = (...vs: number[]) => Math.round(vs.reduce((s,v) => s+(v||0), 0) * 100) / 100;
export const mulMoney = (a: number, b: number) => Math.round(a * b * 100) / 100;
export const eqMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;
```
Y aplicar gradualmente. **No urgente** porque la mayoría de cálculos pasan por RPC SQL donde NUMERIC(20,2) es exacto, pero los tests E2E y los aggregates frontend se beneficiarían.

### 4.2 TZ handling
La regla está clara (`toBuenosAires` / `fmt_dt_ar` en utils.ts) pero **57 `.toISOString()` la ignoran**. La mayoría arman strings tipo `new Date().toISOString().slice(0,10)` para filtrar por "hoy" — esto es UTC. Pages afectadas más críticas:
- `useBandejaEntrada.ts:139` — "facturas vencidas" usa hoyIso UTC → puede dejar entrar/sacar una factura del cutoff cerca de medianoche.
- `useBandejaEntrada.ts:168` — `mp_sin_conciliar` idem.
- `Caja.tsx`, `Compras.tsx`, `ConciliacionMP.tsx`, `Finanzas.tsx`, `RRHH.tsx`, `Reservas.tsx`, `EERR.tsx` (vía `today`) — todos arman `toISO(today)` o `new Date().toISOString().slice(0,10)`.

**Fix:** un helper `hoyAR(): string` en utils.ts que devuelva `YYYY-MM-DD` en zona AR. Reemplazar en pages.

### 4.3 Error reporting
- 29 `console.error` en 13 archivos.
- 0 `logError` o backend sink.
- `ErrorBoundary.tsx:47` solo loguea a consola.
- `consoleCapture.ts` los junta en memoria — pero solo se mandan al backend si el user **manualmente** crea un ticket de soporte.

Para una app en producción real, vale agregar (no urgente, pero queda como deuda):
1. Una RPC `log_client_error(message, stack, context)` que inserte en una tabla `client_errors`.
2. Helper `logError(err, ctx)` que console.error + RPC fire-and-forget.
3. Wire en ErrorBoundary `componentDidCatch` + `unhandledrejection` global.

### 4.4 Hooks sin tests
6 de 8 hooks reales sin test:
- `useRealtimeTable` — sin test (su helper puro sí).
- `usePuestosRRHH` — sin test.
- `useBandejaEntrada` — sin test (a pesar de 6 fetchers complejos).
- `useTenantFeatures` — sin test.
- `useDebouncedValue` — sin test (trivial agregar).
- `useGuardedHandler` — sin test (crítico para anti-doble-click).
- `useLocalContextoUI` — sin test (lógica de "modo vista vs carga" amerita).

Con `@testing-library/react` + `renderHook` instalable sin cambios al stack actual (vitest 4 + jsdom). **No es bloqueante** pero los 3 más críticos (useGuardedHandler, useDebouncedValue, useBandejaEntrada) deberían tenerlo antes de seguir agregando hooks.

### 4.5 Duplicación cache+realtime
3 hooks (`useCategorias`, `useMediosCobro`, `usePuestosRRHH`) implementan **el mismo patrón** con 150 LOC c/u:
```
useState(() => readCache() || FALLBACK)
useEffect(() => { fetch + writeCache })
useRealtimeTable({ table, onChange: refresh })
```
**Refactor candidato:** `useCachedCatalog<T>({ table, columns, ttlMs, fallback })` reduciría a 30 LOC c/u, con tests centralizados.

---

## 5. Acciones recomendadas (priorizadas)

| Prioridad | Acción | Esfuerzo |
|---|---|---|
| 🔴 1 | **Borrar `src/hooks/useFinanzas.ts` + `src/hooks/useNegocio.ts`** (mock orfans, 12.9 KB) | 5 min |
| 🔴 2 | **Borrar `src/lib/services/{caja,rrhh}.service.ts`** (dead + race condition) | 5 min |
| 🔴 3 | **Borrar `src/lib/saldoMP.ts` + `saldoMP.test.ts`** (dead, 8 KB) | 5 min |
| 🔴 4 | **Fix `utils.ts::today`** — convertir a fn o reemplazar consumers por `new Date()` directo. **Bug TZ real en producción.** | 30 min |
| 🟠 5 | Agregar helper `hoyAR(): string` y reemplazar ~57 `.toISOString().slice(0,10)` en pages críticas (useBandejaEntrada, Caja, Compras, EERR) | 1-2 h |
| 🟠 6 | Test para `useGuardedHandler` (anti-doble-click es crítico) | 20 min |
| 🟠 7 | Fix `useToast::setTimeout` sin cleanup | 10 min |
| 🟠 8 | Convergir `fmt_$` ↔ `formatCurrency` ↔ `fmt_money` a uno solo | 1 h grep+replace |
| 🟡 9 | Refactor a `useCachedCatalog<T>` para los 3 hooks de catálogo | 2-3 h |
| 🟡 10 | Test para `useDebouncedValue` (trivial, modelo a seguir para los demás hooks) | 15 min |
| 🟡 11 | Exportar `fromRows` de useCategorias para que el test no duplique código | 5 min |
| 🟢 12 | Crear `lib/money.ts` con helpers + adoptar gradualmente | semana |
| 🟢 13 | Crear `logError(err, ctx)` + tabla `client_errors` + wire en ErrorBoundary | medio sprint |
| 🟢 14 | Unificar códigos legacy duplicados en `errors.ts` + RPCs SQL | 1 h |

**Total acciones 🔴 (1-4):** ~50 min para limpiar 25 KB de dead code + fix bug TZ. Alto ROI, bajo riesgo.

---

## 6. Estado de Convención C6 (debounce)

`useDebouncedValue.ts` existe desde plan sunny-creek. Adoption check:

| Página | Tiene input de búsqueda/filtro | Usa `useDebouncedValue` |
|---|---|---|
| `Caja.tsx` | sí (filtro fecha + cuenta) | sí (importa) |
| `Ventas.tsx` | sí | sí (importa) |
| `Gastos.tsx` | sí | sí (importa) |
| `Compras.tsx` | sí (filtro proveedor + fecha) | **NO** importa — usa filtros directos |
| `Proveedores.tsx` | sí | sí (importa) |
| `RRHH.tsx` | sí (búsqueda empleado) | sí (importa) |
| `ConciliacionMP.tsx` | sí | sí (importa) |

Adoption: **6 de 7 pages.** Compras pendiente — agregar para feedback consistente.

---

## 7. Apéndice — lista completa de archivos `src/lib/` con tamaño y consumidores

| Archivo | KB | Consumidores | Tiene test | Estado |
|---|---|---|---|---|
| `auth.ts` | 17.6 | 50+ archivos | ✅ parcial | Healthy |
| `useBandejaEntrada.ts` | 13.4 | Topbar | ❌ | Hot — bugs TZ |
| `features.ts` | 12.8 | 4 | ❌ | OK |
| `onboardingTours.ts` | 17.2 | 4 | ❌ | No auditado en detalle |
| `useCategorias.ts` | 11.5 | 12 | ✅ (testea copia) | Hot |
| `errors.ts` | 10.9 | 30+ | ✅ | Healthy |
| `printESCPOS.ts` | 10.5 | 1 | ❌ | OK |
| `mpExtractoParser.ts` | 9.5 | 1 | ✅ | Healthy |
| `useMediosCobro.ts` | 7.5 | 8 | ✅ | Healthy |
| `useRealtimeTable.ts` | 7.3 | 9 archivos PASE | ✅ helper | Healthy (cobertura F3C) |
| `push.ts` | 5.4 | 2 | ❌ | OK |
| `sidebar-nav.ts` | 6.0 | App + Layout | ✅ | Healthy |
| `useLocalContextoUI.ts` | 4.9 | 1 | ❌ | OK |
| `useTenantFeatures.ts` | 3.6 | 1 + Layout | ❌ | Falta paridad con useCategorias |
| `notification-types.ts` | 3.8 | 1 | ❌ | OK |
| `chunkLoadErrorHandler.ts` | 3.9 | main + ErrorBoundary | ❌ | OK |
| `usePuestosRRHH.ts` | 3.9 | RRHH + Legajo | ❌ | Healthy |
| `utils.ts` | 3.8 | 16 pages | ✅ | **Bug `today` frozen** |
| `parseCSV.ts` | 3.8 | 1 | ✅ | Healthy |
| `saldoProveedor.ts` | 4.0 | 3 | ✅ | Healthy |
| `parser.ts` (maxirest) | 9.0 | 1 | ✅ | Healthy |
| `rrhh.ts` (calculos) | 11.0 | 4 | ✅ | Healthy |
| `format.ts` | 3.1 | 8 | ✅ | Duplica utils::fmt_$ |
| `consoleCapture.ts` | 3.1 | main + SoporteWidget | ❌ | OK |
| `onboardingProgress.ts` | 3.2 | 2 | ❌ | OK |
| `constants.ts` | 3.1 | useCategorias, useMediosCobro | ✅ indirecto | Healthy |
| `saldoMP.ts` | 3.5 | **0** | ✅ orfan | **MUERTO** |
| `exportCSV.ts` | 2.0 | 5 | ❌ | OK |
| `useGuardedHandler.ts` | 1.9 | 3 | ❌ | **Falta test** |
| `comanda-sso.ts` | 1.3 | 1 | ❌ | OK |
| `supabase.ts` | 1.1 | 50+ | n/a | Healthy |
| `useDebouncedValue.ts` | 1.0 | 6 | ❌ | Falta test trivial |
| `services/caja.service.ts` | 1.5 | **0** | ❌ | **MUERTO + viola C4** |
| `services/rrhh.service.ts` | 1.6 | **0** | ❌ | **MUERTO** |
| `hooks/useFinanzas.ts` | 6.4 | **0** | ❌ | **MUERTO (mock orfan)** |
| `hooks/useNegocio.ts` | 6.3 | **0** | ❌ | **MUERTO (mock orfan)** |
| `hooks/useToast.ts` | 0.9 | 6 | ❌ | Bug cleanup setTimeout |
