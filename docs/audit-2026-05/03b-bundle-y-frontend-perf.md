# Fase 3B — Bundle size & frontend perf

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Scope:** `packages/pase/{vite.config.ts,src/App.tsx,dist/}`, `packages/comanda/{vite.config.ts,tailwind.config.ts,src/App.tsx,dist/}`, deps en `package.json` de ambos paquetes, service worker (PASE custom + COMANDA Workbox via VitePWA), assets `public/`, imports namespace y libs pesadas conocidas (`xlsx`, `recharts`, `jspdf`, `html2canvas`, `@anthropic-ai/sdk`, `exceljs`, `jszip`, `lodash`, `moment`).
**Método:** lectura estática + grep dirigido; **NO se re-buildeó** — se inspeccionó el `dist/` actual ya presente en disco (`packages/pase/dist/assets/` 1.6 MB total / 66 chunks, `packages/comanda/dist/assets/` 1.9 MB total / 161 chunks). Build PASE = `index-DmRQFA-P.js` 117 KB + chunks lazy; build COMANDA = `index-B_UGiFhk.js` **765 KB monolítico**.

---

## 📊 Resumen ejecutivo

| Métrica | PASE | COMANDA |
|---|---|---|
| **Chunk inicial (index.js)** | **117 KB** | **765 KB** 🔴 |
| Vendor splitting | ✅ `vendor-react` (220 KB) + `vendor-supabase` (186 KB) + `vendor-charts` (379 KB lazy) + `vendor-onboarding` (19 KB lazy) | ❌ **0 manualChunks** — todo dentro del index.js |
| Total dist (post-build, sin gzip) | 1.65 MB | 1.93 MB |
| # chunks generados | 66 | 161 |
| Páginas `lazy()` en App.tsx | **32** | **74** |
| Páginas eager (no-lazy) | 1 (Login) | 1 (LoginPage) **+ 6 tabs vía `routeWrappers.tsx`** 🟠 |
| % lazy coverage | ~97% | ~91% (los 6 wrappers rompen la regla C8) |
| `import *` en código propio | 0 | 3 (`base` repos) — no impacta bundle, tree-shake OK |
| Libs pesadas conocidas en bundle browser (`xlsx`/`jspdf`/`html2canvas`/`exceljs`/`jszip`/`@anthropic-ai/sdk`) | **0** ✅ | **0** ✅ |
| Libs pesadas reales en bundle | `recharts` 3.8 (~379 KB chunk lazy ✅), `driver.js` (~19 KB chunk lazy ✅) | `leaflet`+`react-leaflet` (~153 KB chunk lazy ✅), `qrcode` (~23 KB chunk lazy ✅), `lucide-react` (131 imports — tree-shake fino, 1 chunk de ~300 B por icon) |
| Assets `public/` >50 KB | 0 | 0 |
| Tailwind purge `content` config | N/A (PASE no usa Tailwind) | ✅ `['./index.html', './src/**/*.{ts,tsx}']` — correcto, no arrastra `node_modules` |
| Service Worker | Custom `public/sw.js` (push notif only, **no cachea bundles**) | VitePWA Workbox (`registerType:'prompt'` + `clientsClaim`+`skipWaiting`, NetworkFirst para HTML) ✅ |
| `chunkSizeWarningLimit` | default 500 KB | 1000 KB 🟡 (oculta warnings reales) |

### Hallazgos top — ranking por impacto

| # | Finding | Paquete | Severidad | KB ahorrables (no-gzip) |
|---|---|---|---|---|
| 1 | **COMANDA `index.js` 765 KB sin vendor splitting** — todo react/react-dom/router/supabase/radix×10/sonner/lucide/idb/workbox-window cae en un único chunk inicial. PASE prueba que el patrón funciona: con 4 `manualChunks` baja el inicial a 117 KB. | COMANDA | 🔴 ALTO | **~450 KB** del inicial (no del total — pero es lo que el browser descarga y parsea SÍ o SÍ antes de pintar) |
| 2 | **`routeWrappers.tsx` eager-imported en COMANDA App.tsx** (`import { ItemsRoute, GruposRoute, CanalesRoute, ListaPreciosRoute, ModificadoresRoute, EmpleadosListaRoute } from './pages/admin-stubs/routeWrappers'`). Ese archivo eager-importa `ItemsTab` (306 LOC) + `GruposTab` (338) + `CanalesTab` (337) + `ListaPreciosTab` (304) + `ModificadoresTab` (405) + `SettingsEmpleados` (192) = **1.882 LOC + sus deps de UI** entran al index.js aunque el user nunca navegue al admin. Viola regla C8 (lazy obligatorio para páginas). | COMANDA | 🔴 ALTO | ~60–80 KB del inicial |
| 3 | **`chunkSizeWarningLimit: 1000` en `comanda/vite.config.ts`** — eleva el umbral de warning a 1 MB. Si el inicial llega a 999 KB, Vite no se queja. Por eso nadie vio el problema #1. | COMANDA | 🟠 MEDIO | n/a (es un syntoma, no causa) |
| 4 | **`SW custom de PASE (`public/sw.js`) NO cachea bundles**. Solo maneja push-notifications. Eso significa: en cada reload el browser revalida vendor-react.js (220 KB), vendor-supabase.js (186 KB), index.js (117 KB) contra el server — y aunque haya `Cache-Control: immutable` de Vercel por hash en filename, sin SW no hay precache hint. Un encargado que abre PASE 10×/día pega ~5 MB de transferencia evitable/día. | PASE | 🟠 MEDIO | depende de red — 0 si Vercel CDN sirve 304s, hasta 500 KB/reload si revalida |
| 5 | **PASE no tiene COMPRESSION_PLUGIN ni `build.reportCompressedSize`**. No se sabe el tamaño real gzipped que llega al browser. Recharts pasa de 379 KB → ~95 KB gzip; supabase pasa de 186 KB → ~50 KB. El "tamaño real" es 3-4× menor pero no hay telemetría. | ambos | 🟡 MEDIO | n/a (visibilidad) |
| 6 | `lucide-react@1.14.0` — 131 named imports en COMANDA. Genera 1 chunk diminuto por icon (~250–700 B cada uno). Total estimado <40 KB. Tree-shaking **correcto**, pero el Vite split por icon explota el número de requests HTTP/2. Con HTTP/2 push casi gratis; con HTTP/1.1 sumaría latencia. | COMANDA | 🟢 BAJO | n/a |
| 7 | Sin `image optimization plugin` (sharp, vite-imagetools). PASE no tiene imágenes (todo SVG). COMANDA tiene `apple-touch-icon.png` (3.4 KB) + `icon-512*.png` — todos <50 KB ya. No hay loss. | ambos | 🟢 BAJO | 0 |
| 8 | **0 `import * as XLSX` / `lodash` / `moment` en src/**. Las 30 ocurrencias de `import *` en COMANDA son todas Radix (`import * as DialogPrimitive`) o React types — bibliotecas que ya son namespaces ESM correctamente tree-shaken. Sin tree-shake-killers. | ambos | 🟢 — | 0 |
| 9 | **`@anthropic-ai/sdk` solo vive en `packages/instagram-bot/api/_lib/claude.js`** (serverless function, no browser). Confirmado: no contamina el bundle del front. El `LectorFacturasIA` del PASE llama a `/api/claude` (proxy), no embebe el SDK. | ambos | 🟢 — | 0 |
| 10 | `recharts@3.8` — único importer es `EERRCharts.tsx`, lazy-importado por `EERR.tsx`, que a su vez es lazy-importado por App.tsx. Cadena correcta: el chunk `vendor-charts-BQhi8FHG.js` (379 KB) solo baja si el user abre `/eerr`. ✅ | PASE | 🟢 — | 0 (ya está bien) |

---

## 1. Lazy coverage en App.tsx

### PASE — `packages/pase/src/App.tsx`
- **32 páginas con `lazy()`** + `<Suspense>`.
- **1 página eager**: `Login` — correcto por diseño (entry point sin sesión).
- Imports adicionales eager (no son páginas, son core): `db`, `AuthProvider`, helpers de `auth`, `Layout` (Sidebar + css), `SoporteWidget`, `consoleCapture`, tipos.
- Comentario inline en el archivo confirma la regla C8 y la documenta. ESLint rule `pase-local/no-eager-page-import-app` está activa.
- **Veredicto:** ✅ lazy coverage en buena forma. El `index.js` 117 KB que vemos en `dist/` es App.tsx + Layout (669 LOC con sidebar completo) + auth + Login + helpers compartidos. Difícil bajarlo más sin partir Layout.

### COMANDA — `packages/comanda/src/App.tsx`
- **74 páginas con `lazy()`** + `<Suspense>`.
- **1 página eager por diseño**: `LoginPage`.
- **6 páginas eager por bug** (Finding #2): `ItemsRoute, GruposRoute, CanalesRoute, ListaPreciosRoute, ModificadoresRoute, EmpleadosListaRoute`. Vienen de `./pages/admin-stubs/routeWrappers.tsx` que es un módulo eager-imported. El wrapper en sí no es problema (wraps con `useAuth`), pero **importa estáticamente los 6 tabs** en sus líneas 2-7.
- Core eager extenso (más que PASE): `AuthProvider` + `AuthPosProvider` + `SyncEngineLifecycle` (carga `syncEngine.ts` con `pullInitial`/`pullIncremental`/`pushQueue`/`operations`) + `SoporteWidget` + `PWAUpdatePrompt` (con `virtual:pwa-register/react` + `workbox-window`) + `RedirectIfAuth` + `PinGate` + `ErrorBoundary` + `AdminLayout` (con `AdminSidebar` que importa toda la nav config + helpers) + `StubRoute`.
- **Veredicto:** 🟠 lazy coverage ~91%. Los 6 tabs eager + el "core grande" inflan el inicial. Empeora con el problema #1 (sin manualChunks).

---

## 2. Imports pesados (libs conocidas)

```
=== xlsx ===            0 hits en src/ de PASE y COMANDA
=== recharts ===        1 hit: packages/pase/src/pages/EERRCharts.tsx  (lazy via EERR)
=== jspdf ===           0 hits
=== html2canvas ===     0 hits
=== @anthropic ===      1 hit: packages/instagram-bot/api/_lib/claude.js  (serverless, NO browser)
=== exceljs ===         0 hits
=== jszip ===           0 hits
=== leaflet ===         3 hits en COMANDA: DeliveryMap.tsx + RiderPWA.tsx + RiderEnCamino.tsx
                        (los 3 están dentro de páginas lazy ✅)
=== qrcode ===          1 hit: packages/comanda/src/components/QrCanvas.tsx
                        (solo importado por SettingsKds + SettingsMenuQr, ambas lazy ✅)
=== driver.js ===       1 hit: packages/pase/src/lib/onboardingTours.ts
                        (vendor-onboarding chunk lazy 19 KB ✅)
=== lodash ===          0 hits ✅
=== moment ===          0 hits ✅
```

**Conclusión:** **NO hay librerías pesadas filtrando al bundle inicial.** El único "candidato" peligroso era recharts (379 KB), pero está correctamente aislado en `vendor-charts` lazy (Fix de auditoría 2026-05-21 CRIT-12 ya aplicado).

---

## 3. Vite config

### PASE — `packages/pase/vite.config.ts`
✅ Tiene `manualChunks` con 4 buckets:
- `vendor-react` (react + react-dom + react-router + scheduler)
- `vendor-supabase`
- `vendor-charts` (recharts + d3-*)
- `vendor-onboarding` (driver.js)

❌ Sin `sourcemap: false` explícito (default Vite es false en prod, OK).
❌ Sin compression plugin (vite-plugin-compression / brotli).
❌ Sin `build.reportCompressedSize: false` (deja la métrica, está bien).

### COMANDA — `packages/comanda/vite.config.ts`
❌ **Sin `manualChunks`.** Todo cae en un único `index.js` 765 KB.
❌ `chunkSizeWarningLimit: 1000` enmascara el problema.
✅ VitePWA bien configurada: `registerType: 'prompt'` + `clientsClaim` + `skipWaiting` + `NetworkFirst` para HTML.

**Fix sugerido para COMANDA** (drop-in en `vite.config.ts`):

```ts
// ANTES
build: {
  chunkSizeWarningLimit: 1000,
},

// DESPUÉS
build: {
  chunkSizeWarningLimit: 500,  // volver al default — fuerza ver problemas reales
  rollupOptions: {
    output: {
      manualChunks: (id: string) => {
        if (id.includes('node_modules/react-router') ||
            id.includes('node_modules/react-dom') ||
            /node_modules[\\/]react[\\/]/.test(id) ||
            id.includes('node_modules/scheduler')) {
          return 'vendor-react';
        }
        if (id.includes('node_modules/@supabase')) return 'vendor-supabase';
        if (id.includes('node_modules/@radix-ui')) return 'vendor-radix';
        if (id.includes('node_modules/leaflet') ||
            id.includes('node_modules/react-leaflet')) {
          return 'vendor-leaflet';  // redundante con lazy, pero asegura cache
        }
        if (id.includes('node_modules/workbox-') ||
            id.includes('virtual:pwa-register')) {
          return 'vendor-pwa';
        }
        return undefined;
      },
    },
  },
},
```

**Resultado esperado:** `index.js` ~150 KB (igual que PASE), `vendor-react.js` ~220 KB, `vendor-supabase.js` ~190 KB, `vendor-radix.js` ~80 KB, `vendor-pwa.js` ~30 KB. Browser parsea menos en cada nueva versión (solo cambia el app code, los vendors quedan cacheados).

---

## 4. Imports namespace grandes

Resultado del `grep -rn "import \* as"`:

- **PASE:** 0 ocurrencias en src/.
- **COMANDA:** ~30 ocurrencias, TODAS de:
  - `import * as React from "react"` (en componentes Radix-wrapped — patrón shadcn estándar, no afecta bundle).
  - `import * as XxxPrimitive from "@radix-ui/react-xxx"` (Dialog, Toast, Tabs, Switch, Select, DropdownMenu, ScrollArea, Label, Tooltip, Separator). Cada Radix package ya es un namespace ESM tree-shakable correctamente.
  - 3× `import * as base from './base'` en `lib/db/repositories/{itemsRepo,ventasRepo,gruposRepo}.ts` — re-export interno, no agrega peso.

**Veredicto:** ✅ Sin tree-shake-killers. No hay `import * as XLSX from 'xlsx'` ni similares.

---

## 5. Build prod — análisis del `dist/` ya presente

NO se re-buildeó por costo (Lucas paga por uso). Se inspeccionó el `dist/` actual de cada paquete que ya estaba en disco.

### PASE — `packages/pase/dist/assets/` (1.65 MB total / 66 archivos)

Top 10 chunks por tamaño:

| Chunk | Bytes | Tipo | Lazy? |
|---|---|---|---|
| `vendor-charts-BQhi8FHG.js` | 379.218 | recharts + d3 | ✅ lazy (solo `/eerr`) |
| `vendor-react-3-ghoWKf.js` | 220.930 | react + react-dom + router | inicial (correcto) |
| `vendor-supabase-BOWcmPd5.js` | 186.767 | @supabase/supabase-js | inicial (correcto) |
| `index-DmRQFA-P.js` | 117.567 | App.tsx + Layout + auth + Login + utils + types | inicial |
| `RRHH-BavjFfDz.js` | 68.294 | RRHH | ✅ lazy |
| `Compras-VR145eDp.js` | 58.411 | Compras | ✅ lazy |
| `ConciliacionMP-BQBYi-BL.js` | 52.112 | ConciliacionMP | ✅ lazy |
| `Rentabilidad-Bj90URHh.js` | 50.500 | Rentabilidad | ✅ lazy |
| `RRHHLegajo-KCyo7L2x.js` | 41.272 | RRHH/Legajo | ✅ lazy |
| `MensajeriaIG-DtiHx9UR.js` | 31.349 | MensajeriaIG | ✅ lazy |

**Tamaño inicial real (sin gzip):** `vendor-react + vendor-supabase + index + CSS = 220 + 186 + 117 + 10 = ~533 KB` no-gzip. Estimado gzip: ~150 KB. Razonable para un back-office grande con 32 páginas.

### COMANDA — `packages/comanda/dist/assets/` (1.93 MB total / 161 archivos)

Top 10 chunks:

| Chunk | Bytes | Tipo | Lazy? |
|---|---|---|---|
| **`index-B_UGiFhk.js`** | **765.840** 🔴 | App.tsx + react + react-dom + router + supabase + radix + sonner + lucide(parcial) + idb + sync engine + AuthProvider + AdminLayout + 6 tabs eager | **inicial** |
| `leaflet-CA0Vasr9.js` | 153.059 | leaflet | ✅ lazy (3 páginas) |
| `index-BynLS5V8.css` | 81.779 | Tailwind CSS purgado | inicial |
| `VentaScreen-BMeA_-Va.js` | 52.029 | POS | ✅ lazy |
| `utils-DdIvoHsH.js` | 27.548 | shared utils | shared chunk auto |
| `PedidosHub-CVm15tBu.js` | 24.754 | POS | ✅ lazy |
| `QrCanvas-BeUyfgjJ.js` | 23.880 | qrcode | ✅ lazy (2 settings) |
| `TiendaHome-DDtcbn-h.js` | 21.267 | público | ✅ lazy |
| `IntegracionPartnerScreen-Dhy9ILGZ.js` | 20.626 | admin | ✅ lazy |
| `SettingsLocal-CgWY_NJO.js` | 20.335 | admin | ✅ lazy |

**Tamaño inicial real (sin gzip):** `index.js + CSS = 765 + 81 = ~847 KB`. Estimado gzip: ~230–250 KB. **Más alto de lo que debería ser** para una PWA (Google sugiere <170 KB gzip en initial).

**Quién está adentro del 765 KB:** todo el "core eager" de App.tsx + dependencias transitivas. Los principales gordos cocinados son:
- React + ReactDOM + react-router (~150 KB)
- @supabase/supabase-js (~190 KB)
- Radix UI ×10 packages (~80 KB)
- sonner + workbox-window + virtual pwa-register (~30 KB)
- idb (~10 KB)
- lucide-react helpers compartidos
- AdminLayout + AdminSidebar + AdminHeader + AdminBreadcrumb + AdminCategoryItem + UserAvatarMenu
- syncEngine + pullInitial + pullIncremental + pushQueue + operations + conflictResolver + idReconciliation (~40 KB)
- Los 6 tabs eager (`Finding #2`) (~60 KB)

Aplicar Finding #1 (manualChunks) baja el initial a ~150 KB **sin tocar src/**. Aplicar #2 (lazyear routeWrappers) baja otros ~60 KB.

---

## 6. Assets `public/`

```
PASE/packages/pase/public:      favicon.svg, icon-pwa.svg, icons.svg, landing.html, manifest, sw.js  — todos <50 KB
PASE/packages/comanda/public:   apple-touch-icon.png (3.4 KB), favicon.svg, icons/{192,512,512-maskable}.png — todos <50 KB
```

Resultado de `find ... -size +50k`: **0 archivos**.

✅ Sin imágenes pesadas. Sin necesidad de optimización adicional.

---

## 7. Service Worker

### PASE — `packages/pase/public/sw.js` (custom, 2.8 KB)

- Maneja push-notifications de IG (Web Push API).
- Maneja click en notif → abrir/foco a URL.
- **No cachea bundles, no precache, no runtimeCaching.**
- No tiene versioning de cache (no hay `CACHE_NAME`).

**Implicación:** PASE depende 100% del CDN de Vercel para servir bundles con headers correctos. Vercel sirve los `assets/*.[hash].js` con `Cache-Control: public, max-age=31536000, immutable`, así que en práctica el browser cachea bien después del primer hit. Pero si el user abre PASE con cache vacío y red mala, no hay precache hint del SW que acelere la 2da visita.

Esto es 🟠 MEDIO porque PASE es back-office (corre en escritorio del dueño, red estable). El upgrade a Workbox-style precache no es urgente, pero sería un win medible.

### COMANDA — `packages/comanda/public/sw.js` (generado por VitePWA Workbox, 10.4 KB) + `workbox-6829fd8d.js`

✅ Configuración correcta en `vite.config.ts`:
- `registerType: 'prompt'` (no auto-update — buen flow para POS).
- `clientsClaim: true` + `skipWaiting: true` (acepta SW nuevo cuando user click "actualizar").
- `NetworkFirst` para HTML con `networkTimeoutSeconds: 3` → no sirve HTML stale si hay red.
- `CacheFirst` para imágenes con expiración 30 días.
- `navigateFallbackDenylist: [/^\/api\//, /\.supabase\.co/]` → no toca llamadas a Supabase ni a serverless.

✅ Cachea bundles automáticamente (precache generado por Workbox).

---

## 8. Tailwind purge

- **PASE no usa Tailwind** (no hay `tailwind.config.*`). Usa CSS custom-vars y clases utilitarias propias en `src/index.css` / `Layout.tsx`.
- **COMANDA:** `packages/comanda/tailwind.config.ts` línea 6:
  ```ts
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  ```
  ✅ Correcto. Solo escanea `src/` propio, no `node_modules`. El CSS final purgado pesa **81.779 bytes** (`index-BynLS5V8.css`) — ~80 KB es razonable para una app de 338 archivos con Tailwind + tema oscuro + variantes Radix-data-state.

---

## Apéndice — fixes sugeridos por orden de impacto

### Fix #1 — manualChunks en COMANDA (🔴 alto impacto, 10 min de trabajo, 0 riesgo)

Editar `packages/comanda/vite.config.ts` con el snippet de la sección 3.
**Efecto esperado:** initial `index.js` baja de 765 KB → ~150 KB. Vendor chunks quedan cacheados entre deploys (cada deploy típico solo cambia app code).

### Fix #2 — Lazyear `routeWrappers.tsx` en COMANDA (🔴 alto impacto, 15 min, riesgo mínimo)

ANTES (`packages/comanda/src/App.tsx` líneas 27-30):
```ts
import { StubRoute } from './pages/admin-stubs/StubRoute';
import {
  ItemsRoute, GruposRoute, CanalesRoute, ListaPreciosRoute,
  ModificadoresRoute, EmpleadosListaRoute,
} from './pages/admin-stubs/routeWrappers';
```

DESPUÉS:
```ts
import { StubRoute } from './pages/admin-stubs/StubRoute';

const ItemsRoute       = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ItemsRoute })));
const GruposRoute      = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.GruposRoute })));
const CanalesRoute     = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.CanalesRoute })));
const ListaPreciosRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ListaPreciosRoute })));
const ModificadoresRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.ModificadoresRoute })));
const EmpleadosListaRoute = lazy(() => import('./pages/admin-stubs/routeWrappers').then(m => ({ default: m.EmpleadosListaRoute })));
```

(Alternativa mejor: convertir cada Tab en su propia ruta lazy y deprecar `routeWrappers.tsx`. Más invasivo, pero más limpio.)

**Efecto esperado:** ~60–80 KB menos en el initial chunk (los 1.882 LOC de los 6 tabs + sus deps UI).

### Fix #3 — Bajar `chunkSizeWarningLimit` a 500 en COMANDA (🟠 medio, 1 línea)

```ts
build: { chunkSizeWarningLimit: 500 }
```

Sin esto, los próximos sprints podrían sumar otro 200 KB al initial sin que el build se queje.

### Fix #4 — Considerar Workbox/SW con precache para PASE (🟠 medio, ~30 min)

Agregar `vite-plugin-pwa` a `packages/pase/vite.config.ts` con `registerType: 'prompt'` + precache de bundles + `NetworkFirst` para HTML — patrón idéntico al de COMANDA. PASE no es PWA-installable (no es el objetivo), pero el precache acelera reload+visita 2da.

### Fix #5 — Agregar `vite-plugin-compression` en ambos (🟡 bajo, 10 min)

Genera `.gz` y `.br` durante el build. Vercel ya los sirve si están en el output. Ahorro real ~3-4× en bytes-en-cable.

---

## Para la próxima fase

- Si Fase 4 (Frontend PASE) o Fase 5 (COMANDA) tocan App.tsx, vale revisar Findings #1 y #2 acá antes de mergear nuevas features — son fixes de baja fricción que el equipo va a olvidar si no se hace ahora.
- Métrica concreta a tomar después de aplicar Fix #1 y #2: re-buildear COMANDA y comparar `ls -lhS dist/assets/index-*.js | head -1` antes/después. Target: <200 KB en el initial.
- No se verificó Lighthouse score real (requeriría deploy + medición desde browser). Estimación: COMANDA hoy ~50-60 en mobile por el initial bundle; con Fix #1+#2 debería pasar 80+.
