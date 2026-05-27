# 07A · Duplicación y Overengineering · 2026-05-27

Auditoría meta posterior a F1-F6. Foco en código duplicado cross-paquete,
abstracciones overengineered, oportunidades de consolidar en `@pase/shared`,
y verificación real de las convenciones C1-C11 declaradas en `CLAUDE.md`.

## Resumen ejecutivo

| Métrica | Valor |
|---|---|
| LOC duplicadas literal/quasi-literal entre paquetes | **~1.700 LOC** |
| Archivos duplicados >90% idénticos | 6 (3 pares) |
| `@pase/shared` real | **vacío** (scaffold `export {}`) pese a estar declarado en `comanda/package.json` |
| RPCs Postgres definidas | ~120; **52 ocurrencias** de `CREATE OR REPLACE FUNCTION` en migrations (varias redefinen la misma fn 2-3 veces en archivos separados) |
| Migrations SQL en `packages/pase/supabase/migrations/` | **292** archivos |
| RPCs sin `p_idempotency_key` | ~70 (de las nuevas/recientes, 50 archivos sí lo aceptan) |
| Adopción C4 (no INSERT directo financieras) | 10 disables `deuda C4-F{12,13,14}` (3 zonas) |
| Adopción C6 (debounce filtros texto) | 4 de 8 páginas con `placeholder=Buscar...` |
| TODO/FIXME reales (no falsos positivos del "TODOS" español) | 5 (3 lint-cleanup, 2 sprint próximo) |
| Tests | PASE 86 · COMANDA 41 · admin-console 0 · IG bot 0 |
| Páginas PASE >1000 LOC | 6 |
| Páginas COMANDA >600 LOC | 5 |
| URL Supabase hardcodeada en código fuente | 3 paquetes (PASE, COMANDA, admin-console) |

**Veredicto:** la duplicación NO es masiva pero es muy mecánica de eliminar.
El `@pase/shared` scaffold lleva ~1 mes sin contenido real mientras se
copy-pastean los mismos 4-5 archivos a cada paquete nuevo (admin-console
agregado después es la prueba más reciente — su `features.ts` es byte-idéntico
al de PASE, 336 LOC).

Overengineering es BAJO en código (el repo prefiere copy-paste a abstracción
prematura, lo cual es sano). El único caso claro es COMANDA con **3
sistemas de toast en paralelo** (`use-toast.ts` shadcn pattern + `useNotifier`
custom + Sonner) y solo Sonner se usa activamente.

## Findings por severidad

### 🔴 Crítica

#### F-DUP-01 · `useRealtimeTable` duplicado con divergencias funcionales
**Archivos:**
- `packages/pase/src/lib/useRealtimeTable.ts:1-180`
- `packages/comanda/src/lib/useRealtimeTable.ts:1-205`

**Problema:** Los dos hooks son 95% idénticos (mismo nombre, mismo
`buildRealtimeConfig` exportable, mismo bug histórico documentado palabra
por palabra en comentarios). Pero divergieron en parámetros sensibles:

| Param | PASE | COMANDA |
|---|---|---|
| `debounceMs` default | **500** | **1500** |
| `fallbackPollMs` default | **30.000** | **60.000** |
| Visibility-paused fireDebounced | **sí** (descarta evento si `hidden`) | **no** |
| Compat `user.locales` vs `user._locales` | **sí** | **no** (solo `user.locales`) |

Ambos hooks resuelven el mismo problema con la misma estructura. La
divergencia de defaults se hizo en sprints distintos sin que el otro se
actualice (PASE 2026-05-17 bajó a 500ms, COMANDA quedó en 1500ms del
sprint anterior). 40 callers entre ambos packages.

**Recomendación:** Mover a `@pase/shared/hooks/useRealtimeTable.ts` con
defaults intermedios (debounce 800ms, poll 45s) y permitir override. La
diferencia "compat _locales" es cosmética — el shape se puede unificar
con `user.locales ?? user._locales ?? []`.

**Ahorro:** ~190 LOC + elimina la posibilidad de drift futuro.

---

#### F-DUP-02 · `features.ts` BYTE-IDÉNTICO entre PASE y admin-console
**Archivos:**
- `packages/pase/src/lib/features.ts` (336 LOC)
- `packages/admin-console/src/lib/features.ts` (336 LOC)

`diff` retorna 0 bytes. Es el caso más obvio de algo que debería vivir
en `@pase/shared`: es un catálogo estático de feature flags + helpers
puros sin dependencias de UI ni DB. **Cualquier cambio futuro al
catálogo de features se va a olvidar de actualizar el otro archivo.**

`useTenantFeatures.ts` también está duplicado entre los dos paquetes (95%
idéntico, solo cambia el cache key prefix `pase_` vs `admin_` y el path
de import del cliente Supabase).

**Recomendación:** mover `features.ts` y `useTenantFeatures.ts` a
`@pase/shared/features`. Parámetrizar el cache key.

**Ahorro:** 336 + ~90 LOC + elimina drift garantizado.

---

#### F-DUP-03 · `@pase/shared` declarado como dep pero vacío
**Archivos:**
- `packages/comanda/package.json:18` — `"@pase/shared": "workspace:*"`
- `packages/shared/src/index.ts` — `export {};`

COMANDA importa el package en `package.json` pero el package solo exporta
nada. El comentario del propio `index.ts` dice:

> "Por ahora vacío — la extracción real de utils/types/services desde
> `packages/pase/src/lib/` se hace en un sprint dedicado entre Fase 1 y
> COMANDA Ola 1, cuando se sepa qué se comparte y qué no."

Ya pasó la Fase 1 (PASE en producción), COMANDA está en Sprint 8 y se
agregaron admin-console + instagram-bot. **El "sprint dedicado" nunca
ocurrió** y cada paquete nuevo se sumó con copy-paste.

**Recomendación:** sprint corto (~1 sesión) para mover los 5-6 archivos
candidatos seguros: `format.ts`, `useDebouncedValue.ts`, `useGuardedHandler.ts`,
`useRealtimeTable.ts`, `features.ts`/`useTenantFeatures.ts`, `consoleCapture.ts`.
Tipo `Tenant` mínimo. Mientras tanto la dep workspace no daña pero engaña
al lector.

---

#### F-DUP-04 · 3 implementaciones distintas de "formato $ argentino"
**Archivos y semánticas:**

| Función | Archivo | Decimales | Símbolo | Negativos |
|---|---|---|---|---|
| `fmt_$` | `packages/pase/src/lib/utils.ts:76` | **2 fijos** | `$X.XXX,XX` pegado | `-$` o `−$` (depende navegador) |
| `formatCurrency` | `packages/pase/src/lib/format.ts:23` | **0** (locale default) | `$X.XXX` pegado | `−$` (Unicode U+2212) |
| `formatARS` | `packages/comanda/src/lib/format.ts:3` | **2 fijos** | `$X.XXX,XX` con espacio (Intl default) | `-$X.XXX,XX` |
| `formatCurrencyCompact` | `packages/pase/src/lib/format.ts:39` | k/M | igual | igual |

`fmt_$` y `formatARS` no son intercambiables: COMANDA introduce un
espacio entre `$` y dígitos por usar `Intl.NumberFormat` puro; PASE lo
saca con `.replace()`. El monto `$1.234,56` en PASE es `$ 1.234,56` en
COMANDA. Hay 2 design-system docs distintos en cada paquete.

**Recomendación:** unificar en `@pase/shared/format/currency.ts`. Una
sola función con flags `{ decimals?: 0|2, compact?: boolean }`. El "símbolo
pegado" es regla establecida en `DESIGN_SYSTEM.md` raíz — se está violando
en COMANDA.

---

#### F-DUP-05 · Cliente Supabase hardcodea misma URL en 3 paquetes
**Archivos:**
- `packages/pase/src/lib/supabase.ts:3`
- `packages/comanda/src/lib/supabase.ts:3`
- `packages/admin-console/src/lib/supabase.ts:9`

Los tres tienen `const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';`
hardcodeado. Si se migra de proyecto Supabase (algo poco probable pero
no imposible: clonar prod para staging, splitear por región, etc.), hay
que tocar 3 archivos + 6+ `.env.local` + docs.

**Recomendación:** mover a `VITE_SUPABASE_URL` en cada `.env.local`
(COMANDA ya lo tiene) y unificar el constructor del client en
`@pase/shared/supabase.ts`. Bono: errores de tipo del generic `Database`
se centralizan.

---

### 🟠 Alta

#### F-OE-01 · COMANDA tiene 3 sistemas de toast en paralelo, solo 1 se usa
**Archivos:**
- `packages/comanda/src/hooks/use-toast.ts` — 196 LOC, shadcn-style reducer + listeners + state machine. **Usado por 1 archivo: `components/ui/toaster.tsx`** (que tampoco se importa desde páginas).
- `packages/comanda/src/lib/useNotifier.ts` — usado en 2 archivos.
- `sonner` (package.json) — usado en **71 archivos**. Es el real.

`use-toast.ts` fue importado desde shadcn como template y nunca se
desconectó. Es overengineered (state global, queue de remove,
TOAST_REMOVE_DELAY = 1.000.000ms o sea ~16 minutos) y dead code.

**Recomendación:** eliminar `hooks/use-toast.ts` + `components/ui/toaster.tsx`
+ `components/ui/toast.tsx` (~400 LOC entre los tres). Migrar los 2
callers de `useNotifier` a Sonner. Quedar con un único sistema.

---

#### F-DUP-06 · IG bot — 5 endpoints duplican init de Supabase
**Archivos:**
- `packages/instagram-bot/api/_lib/db.js` — ya existe el helper.
- `packages/instagram-bot/api/auth-bridge.js:45-48`
- `packages/instagram-bot/api/send.js:19-45`
- `packages/instagram-bot/api/notif-pendientes-process.js:24-79`
- `packages/instagram-bot/api/oauth-callback.js` (varias)
- `packages/instagram-bot/api/refresh-tokens.js`

`_lib/db.js` exporta un `db` ya configurado pero 5 de 7 endpoints lo
re-inicializan inline con su propio `createClient`. Es código muerto +
riesgo de divergencia de opciones de auth.

**Recomendación:** sustituir cada inline por `import { db } from './_lib/db.js'`.
Ahorro neto: ~50 LOC.

---

#### F-C1-01 · Idempotency: 50 archivos sí, pero muchas RPCs antiguas no
**Stat:** 50 migration files contienen `p_idempotency_key`. Pero las
RPCs de la migración Fase 1 (`202605270700_audit_f1_criticos.sql`, 1366
LOC) que redefine `eliminar_cierre`, `eliminar_venta`, `anular_factura`,
`anular_movimiento`, `aplicar_nc_a_factura`, `crear_gasto_empleado`,
`pagar_vacaciones`, `pagar_aguinaldo` — **NINGUNA acepta `p_idempotency_key`.**

`grep` en ese archivo: `p_idempotency_key` aparece 4 veces, todas como
`COMMENT ON FUNCTION` mencionando que NO usa idempotency. La excusa es
que son "anulaciones" y por idempotencia natural del UPDATE (idempotent
by data, no by call) — válido pero NO documentado en la convención C1.

**Recomendación:** explicitar en `CLAUDE.md` C1: "RPCs de mutación
financiera que crean filas: requieren `p_idempotency_key`. RPCs de
anulación/cancelación: opcional si el segundo call es no-op SQL-side."
Sin esa nota la regla es ambigua.

---

#### F-C4-01 · Convención C4 violada en 3 zonas concretas (deuda explicitada)
Búsqueda `eslint-disable.*deuda C4-F`:
- **`Compras.tsx:627`** — F12: cargar remito directo, falta `crear_remito` RPC.
- **`RRHH.tsx:724, 726, 758, 799`** — F14: delete+insert de liquidación + rollback novedad + borrado novedad. 4 violaciones.
- **`ImportarMaxirest.tsx:109, 180, 190, 193`** — F13: importer batch con rollback manual.
- **`rentabilidad/TabComprasSugeridas.tsx:145`** — F12 también.

10 disables, 3 RPCs faltantes (`crear_remito`, `confirmar_novedad` +
`editar_novedad` + `eliminar_novedad`, `importar_maxirest_batch`). Todo
con comentario detallado del por qué; la deuda está bien declarada.

**Recomendación:** F13 (importer Maxirest) es la más peligrosa — si la
RPC falla a mitad del batch, los saldos de cuentas quedan inflados
(self-documented). Priorizar.

---

#### F-C6-01 · Debounce en filtros texto: 4/8 páginas
8 páginas tienen `<input placeholder="Buscar...">`:
- ✅ `Gastos.tsx`, `ConciliacionMP.tsx`, `Compras.tsx`, `Ajustes.tsx` — usan `useDebouncedValue`.
- ❌ `rentabilidad/TabStock.tsx`, `rrhh/TabEmpleados.tsx`, `Proveedores.tsx`, `compras/ModalCargarFactura.tsx` — filtran sin debounce.

Las 4 que faltan son filtros client-side (lista ya en memoria), no
dispara queries a Supabase. Impacto = render React por cada keystroke en
listas chicas (<200 items), no egress. Severidad baja-real pese a la regla.

**Recomendación:** o bajar la criticidad de C6 (filtros memoria-only no
necesitan debounce) o agregar `useDebouncedValue` en los 4 casos por
consistencia. Es mecánico (2 líneas por archivo).

---

### 🟡 Media

#### F-DUP-07 · `useDebouncedValue` y `useGuardedHandler` duplicados
**Archivos:**
- `packages/pase/src/lib/useDebouncedValue.ts` (26 LOC) vs `packages/comanda/src/lib/useDebouncedValue.ts` (26 LOC). **Solo difieren en comillas (`"` vs `'`).** Diff útil = 0.
- `packages/pase/src/lib/useGuardedHandler.ts` (48 LOC) vs `packages/comanda/src/lib/useGuardedHandler.ts` (35 LOC). PASE tiene un branch extra.

**Recomendación:** candidatos perfectos para `@pase/shared/hooks/`.

---

#### F-DUP-08 · `consoleCapture.ts` duplicado con divergencia
**Archivos:**
- `packages/pase/src/lib/consoleCapture.ts` (100 LOC)
- `packages/comanda/src/lib/consoleCapture.ts` (89 LOC)

PASE tiene 11 LOC extra (no chequeé qué). Mismo propósito, mismo nombre,
divergencia silenciosa.

---

#### F-DUP-09 · `errors.ts` (`translateRpcError`) en PASE vs `translateError` en COMANDA
**Archivos:**
- `packages/pase/src/lib/errors.ts` (193 LOC) — `translateRpcError`.
- `packages/comanda/src/lib/errors.ts` (129 LOC) — `translateError`.

Catálogos de error codes parcialmente solapados (`FACTURA_YA_PAGADA`,
`SALDO_INSUFICIENTE` están en ambos con la misma traducción). COMANDA
también define códigos POS-only (`OVERRIDE_REQUIRED`, etc.). Ningún
mecanismo previene que se traduzca distinto el mismo código.

**Recomendación:** `@pase/shared/errors.ts` con un Map base + cada
paquete extiende. O al menos test cross-paquete que valide que los
códigos compartidos traducen igual.

---

#### F-MIG-01 · 292 migrations + 5 redefiniciones de la misma función
**Stat:** `grep CREATE OR REPLACE FUNCTION public\.X` → casos donde la
misma función se redefine en >1 archivo:
- `pagar_sueldo` — 3 veces (`202604261840`, `202605270600`, `202605270700`).
- `crear_gasto_empleado` — 3 veces (`202605250100`, `202605270600`, `202605270700`).
- `eliminar_venta`, `eliminar_cierre`, `anular_movimiento` — 2 veces cada una.

Las redefiniciones son hot-fixes incrementales (correcto en un repo
migration-only). Pero la última versión es la que importa; los archivos
viejos quedan como ruido. Difícil borrar (no se puede romper la
secuencia para re-aplicar from scratch).

**Recomendación:** mantenerlas pero documentar en cada archivo viejo un
comentario `-- DEPRECATED: ver 202605270700:444 para la versión vigente`.
A futuro, considerar una baseline consolidada cada 6 meses (squash de
migrations pre-baseline en una sola).

---

#### F-MIG-02 · `eliminar_tenant_completo` redefinido 5+ veces en 1 semana
**Archivos:**
- `202605223000_eliminar_tenant_completo_dinamico.sql`
- `202605222900_eliminar_tenant_completo_v2.sql`
- `202605223100_eliminar_tenant_fks_circulares.sql`
- `202605223200_eliminar_tenant_robusto.sql`
- `202605223300_eliminar_tenant_recetas_versiones.sql`
- `202605241700_fix_eliminar_tenant_disable_triggers.sql`

6 migrations en 4 días tocando la misma fn = bug-fixing iterativo
contra tenant E2E. Funcionó pero es señal de que la fn quedó frágil.

**Recomendación:** invariante test en suite E2E full ya lo cubre
indirectamente (sesión 22-may). Considerar agregar test SQL aislado
de `eliminar_tenant_completo` con cleanup verification.

---

#### F-OE-02 · 23 services COMANDA con <5 funciones cada uno
**Stat:** 45 service files, 423 exports = 9.4 avg/file. Distribución
sugiere fragmentación: 23 archivos tienen ≤5 exports.

Ejemplos `descuentosService.ts` (2 exports), `materiasPrimasService.ts`
(1 export). Algunos servicios podrían fusionarse por dominio (todo lo
de "catálogo" en un solo archivo).

**Recomendación:** baja prioridad. La granularidad fina ayuda al
tree-shaking pero confunde la navegación. Solo consolidar si se hace
refactor mayor de catálogo.

---

#### F-OE-03 · Páginas PASE >1000 LOC sin descomposición
**Top:**
- `ConciliacionMP.tsx` — **1.687 LOC**
- `RRHHLegajo.tsx` — **1.257 LOC**
- `Compras.tsx` — **1.214 LOC** (tiene sub-archivos `compras/Modal*` extraídos, pero el shell sigue gordo)
- `Caja.tsx` — **1.081 LOC**
- `RRHH.tsx` — **1.075 LOC**
- `Gastos.tsx` — **1.015 LOC**

Compras es el ejemplo correcto a seguir: extrajo 7 modals a `pages/compras/`.
Los otros 5 mantienen toda la lógica inline. Ya cubierto en F4A reportes
previos.

---

### 🟢 Baja

#### F-DUP-10 · Tipos duplicados localmente (no entre paquetes)
**Stat:** búsquedas `interface Movimiento`, `interface Empleado`:
- `packages/pase/src/types/finanzas.ts:1` — canónico `Movimiento`.
- `packages/comanda/src/pages/Caja/CajaChica.tsx:21` — define `interface Movimiento` local (4 fields).
- `packages/pase/src/types/rrhh.ts:1` — canónico `Empleado`.
- `packages/comanda/src/pages/Empleados/PropinasReparto.tsx:29` — define `interface Empleado` local.

Son shapes mínimos para esa pantalla. NO son `Usuario` (que sí diverge
intencionalmente — Sprint Autónomo 24-may para `comanda_usuarios`).

**Recomendación:** trivial — renombrar a `MovimientoRow` / `EmpleadoRow`
locales o usar el canónico con `Pick<>`. Baja prio.

---

#### F-TODO-01 · 5 TODOs reales en todo el código
Filtrado de los falsos positivos (la palabra "TODOS" en español dispara
greps). Reales:
- `RRHHLegajo.tsx:220` — `TODO(lint-cleanup): Date.now() durante render`.
- `ConciliacionMP.tsx:415` — `TODO(lint-cleanup): Date.now() en async handler`.
- `RRHH.tsx:832` — `TODO(lint-cleanup): abrirPagoSueldo declarado abajo`.
- `useCategorias.ts:183` — `TODO(lint-cleanup): setState declarado abajo`.
- `printerService.ts:207` — `TODO sprint próximo: endpoint /open-drawer`.
- `AjusteStockDialog.tsx:69,72` — `TODO sprint próximo: integrar ManagerOverrideDialog`.

3 son lint-cleanup (deuda menor). 2 son features postergadas con
workaround documentado. **No hay FIXME ni HACK.** El repo está
sorprendentemente limpio.

---

#### F-TEST-01 · Coverage muy desigual entre paquetes
**Stat:**
- PASE: 86 archivos de test.
- COMANDA: 41 archivos de test.
- admin-console: **0** archivos de test.
- instagram-bot: **0** archivos de test.

admin-console y instagram-bot son productivos (admin-console maneja
superadmin operaciones; instagram-bot recibe webhooks reales de Meta).

**Recomendación:** al menos 1 test smoke por paquete que valide
conexión a Supabase + parse de payloads. Cero tests en un endpoint que
acepta webhooks de Meta sin validar firma sería 🔴, pero ya cubrieron
en F6.

---

#### F-OE-04 · Comments stale (3 instancias)
- `useRealtimeTable.ts` (ambos): "Optimización egress 2026-05-17: subido
  de 200 → 500ms" — solo en PASE. COMANDA tiene "sprint optim egress
  2026-05-16, antes 200". Ambos optimizaron el mismo problema en días
  distintos sin sincronizar.
- `format.ts` COMANDA: `@deprecated Sprint 8: usar formatFecha(iso, useTimezone())` —
  Sprint 8 ya pasó (estamos en post-S8) pero las funciones siguen ahí y
  usadas. La deprecación es nominal.
- `packages/shared/src/index.ts`: "se hace en un sprint dedicado entre
  Fase 1 y COMANDA Ola 1" — Fase 1 cerrada hace tiempo, no hubo sprint.

---

#### F-OE-05 · 24 archivos en `packages/pase/api/`, **12 son endpoints reales**
Los `_*.js` son helpers privados (correcto según CLAUDE.md L70 sobre el
límite Vercel Hobby de 12 functions). Conteo coincide exactamente:
12 endpoints + 12 helpers/tests. **Estamos en el límite duro.** Próximo
endpoint (e.g. nuevo webhook MP, AFIP refresh) requiere consolidación
o upgrade del plan.

**Recomendación:** ya documentado en CLAUDE.md. Reiterar: antes de
sumar function, considerar si puede ir como sub-path de una existente
(e.g. `mp-process.js` podría exponer `?action=generate|process|sync`).
Ahorra slots, agrega comp léxica chica.

---

## Cuadro consolidado de oportunidades para `@pase/shared`

| Archivo candidato | LOC actuales (dupe total) | Ganancia tras consolidar |
|---|---|---|
| `useRealtimeTable.ts` | 385 | -190 |
| `features.ts` + `useTenantFeatures.ts` | 770 | -425 |
| `useDebouncedValue.ts` | 52 | -26 |
| `useGuardedHandler.ts` | 83 | -35 |
| `consoleCapture.ts` | 189 | -89 |
| `format.ts` (currency unificado) | 147 | -65 |
| `errors.ts` (catálogo base) | 322 | -100 (estimado) |
| `supabase.ts` client + URL env-var | 75 | -40 |
| **Total estimado** | **2.023** | **~970 LOC eliminadas** |

Sprint de 1 sesión, sin riesgo (todas son funciones puras o hooks UI).
El blocker es la falta de gen-types de Supabase consolidados — pero los
candidatos arriba NO dependen de Database<>.

## Prioridades sugeridas

1. 🔴 **F-DUP-03 + F-DUP-02 juntos**: sprint dedicado de 1 sesión para
   llenar `@pase/shared` con los 4-5 archivos seguros. Resuelve 3
   findings 🔴 de un saque.
2. 🔴 **F-DUP-05**: mover URL a env var antes de cualquier hipotético
   split de proyecto Supabase.
3. 🟠 **F-OE-01**: limpiar el shadcn toast muerto de COMANDA (~400 LOC
   menos, riesgo cero porque no se usa).
4. 🟠 **F-C1-01**: aclarar redacción de C1 en CLAUDE.md para no quedar
   en falsa adopción.
5. 🟠 **F-C4-01 F13 (Maxirest importer)**: la deuda C4 más peligrosa
   (saldos inflados al fallar mid-batch).
6. 🟡 resto: opportunista, no bloqueante.

## Cosas que NO encontré (señales sanas)

- Cross-paquete imports relativos `../../pase/src/lib/X` → cero. Limpio.
- Wrappers innecesarios sobre `db` → cero (services usan `db` directo,
  no proxies vacíos).
- TypeScript genéricos sobreingenierados → no encontrados.
- "God objects" — el archivo más importado no se mide acá pero ningún
  archivo se importa desde 20+ lugares en mi sampleo.
- Migrations contradictorias (CREATE + DROP del mismo objeto) → solo
  3 casos de DROP IF EXISTS y todos seguidos de CREATE legítimo en la
  misma migration (no son deshechos).
- TODOs colgados de sprints pasados → 5 totales, todos vigentes o
  marcados como deuda.

El repo está sorprendentemente bien para 84.000 LOC. La duplicación
existente es por inercia (no se invirtió en `@pase/shared`), no por
descuido. Una sesión enfocada cierra la deuda principal.
