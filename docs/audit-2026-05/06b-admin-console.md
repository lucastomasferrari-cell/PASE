# 06b — Auditoría Admin Console (`packages/admin-console`)

Fecha: 2026-05-27 · Scope: SPA superadmin React (Vite + React 19 + Supabase JS).
Archivos: 7 páginas + 4 componentes + 5 lib + 2 archivos infra (`vercel.json`,
`eslint.config.js`) + 1 SW (`public/sw-push.js`) + 1 endpoint compartido
(`packages/pase/api/crear-tenant.js`). Total ~3000 LOC TSX + ~700 LOC TS lib.

## Resumen ejecutivo

Estado real:

- **Auth gate sólido** — `useAuth()` valida sesión Supabase + lookup en
  `usuarios` exigiendo `rol='superadmin'` y `activo=true`. `auth_es_superadmin()`
  + RLS dual del lado DB cubren backend (incluso si la SPA fuera bypassada,
  RLS rechaza). Hay 4 estados explícitos (`loading/unauthenticated/forbidden/
  authenticated`) y mensajes claros para `forbidden`. **Mejor que la pantalla
  vieja de PASE** (que tenía gates client-only).
- **Sin endpoints propios** — admin-console no tiene `api/` dir. Todas las
  mutaciones van por Supabase RPC (RLS las gatea con `auth_es_superadmin()`),
  excepto crear-tenant que llama a `packages/pase/api/crear-tenant.js` con JWT
  en `Authorization: Bearer`. F2C confirmó que no hay leaks de SERVICE_KEY.
- **CRUD de tenants es muy fino** — wizard de 4 pasos con validaciones,
  mapping de error codes a español, rollback atómico en el backend. Lo que
  falta es **borrar** y **restore** — esas RPCs (`eliminar_tenant_completo`,
  `restore_tenant`) existen en DB pero el admin-console NO las invoca de
  ninguna parte. Lucas hoy borra tenants con script Node o Supabase Studio.
- **Feature flags con auditoría real** — la migration `202605270300_tenant_features.sql`
  hace INSERT en `auditoria` para cada SET/SET_BULK/RESET. Bien. El frontend
  cachea con TTL 5 min (`useTenantFeatures.ts`) e invalida después de cada
  cambio. Optimistic UI con rollback en error.
- **`toggleActivo` en Tenants.tsx NO usa RPC ni audita** — escribe directo
  `db.from('tenants').update({ activo })`. RLS lo permite porque el caller es
  superadmin, pero no queda registro de quién/cuándo desactivó un tenant.
  Esto es un módulo de plata indirecto (desactivar un tenant le quita acceso
  a todos sus operativos) — debería pasar por RPC con audit.
- **Botón "Ver como tenant" está roto silenciosamente** — abre
  `https://pase-yndx.vercel.app/?as=<uuid>` en una tab nueva, pero PASE
  NUNCA lee el query param `?as=` (verificado con grep). El selector de
  tenant en PASE solo lee `sessionStorage.pase_tenant_override__superadmin_only`,
  que es del DOMINIO PASE. Resultado: Lucas clickea "Ver" y termina viendo
  su propio tenant (Neko). El comentario en el código (lines 88-95) admite
  el problema pero no se resolvió.
- **`prompt()` para "método de pago"** — `Pagos.tsx:160` pide método de pago
  con un nativo `prompt()`. Acepta cualquier string libre. Si Lucas tipea
  "transferencia bancaria" pero el reporte espera "transferencia", se rompe
  la categorización futura. Idem `prompt('Notas opcionales:')` para notas
  arbitrarias. UX 2002.
- **Tickets list sin paginación** — `listTickets()` tiene `.limit(200)`
  hardcoded. Cuando el sistema crezca a >200 tickets totales, la pestaña
  "Todos" muestra parcial y los contadores (`abiertos: abiertosRes.data.length`)
  caen al límite también. Sin búsqueda por texto.
- **Sin Realtime ni subscriptions a tickets** — el agente puede pasar de
  `investigating` → `fixing` → `pr_opened` sin que la UI se entere hasta el
  próximo `loadList()`. Tampoco hay refetch en focus. Lucas tiene que
  apretar F5 manualmente. La idea del push notification compensa parcialmente
  (notif → click → re-renderiza), pero el listado abierto queda stale.
- **Confirmación con `window.confirm()` para acciones críticas** — toggle
  tenant, marcar invoice pagada, bulk activar/desactivar features. UX muy
  pobre — sin contexto visual, sin "tipear el nombre del tenant para
  confirmar", sin diff de lo que va a cambiar.
- **Sin tests** — no hay un solo `.test.ts` o `.spec.ts` en el paquete.
  No hay coverage para auth gate, para el wizard de tenant, para el
  toggle de feature flag, para el marcado de invoice como pagada.
  Para una herramienta que decide a qué cliente le doy acceso a qué función
  esto es deuda fuerte.
- **`Metricas.tsx` query no eficiente** — lee `tickets_soporte`
  con `.select('tenant_id, estado').neq('estado', 'cerrado')` sin paginar y
  sin agregar por DB. Si hay 10k tickets abiertos pega 10k rows al cliente
  para contar. Hay un índice (`tickets_soporte (tenant_id, estado, prioridad, created_at DESC)`)
  pero la query trae los datos enteros igual.
- **Push notifications bien implementadas** — VAPID key, upsert con UNIQUE,
  device label heurístico, signed URLs de screenshots (5min TTL), bucket
  privado. El SW navigates a `/soporte` o a la URL del payload — OK.
- **Pago manual con `prompt()` no documenta `gateway_payment_id`** — al
  pasar `null` siempre, perdés el ID externo del pago si lo tenés
  (transferencia con CBU, ID MP del cobro manual, etc.). Hace difícil
  conciliar después.

## Tabla findings por severidad

| #  | Sev | Área              | Item                                                                                                    | Archivo:línea |
|----|-----|-------------------|---------------------------------------------------------------------------------------------------------|---------------|
| 1  | 🔴  | UX / bug fantasma | Botón "Ver como tenant" no funciona — abre URL con `?as=` que PASE ignora                               | `src/pages/Tenants.tsx:88-95` |
| 2  | 🟠  | Audit / governance| `toggleActivo` (activar/desactivar tenant) escribe directo sin RPC ni audit log                         | `src/pages/Tenants.tsx:97-103` |
| 3  | 🟠  | UX / data quality | Método de pago via `prompt()` libre → categorías inconsistentes para reportar después                   | `src/pages/Pagos.tsx:160-169` |
| 4  | 🟠  | Power features    | Faltan UI para borrar (`eliminar_tenant_completo`) y restaurar (`restore_tenant`) — Lucas usa scripts   | (ausente en `src/pages/Tenants.tsx`) |
| 5  | 🟠  | Tests             | Cero tests en el paquete. Cero coverage del wizard, auth gate, feature flag toggle, marcar pagada      | toda la carpeta |
| 6  | 🟠  | Scaling           | `listTickets().limit(200)` hardcoded sin paginación; contadores usan `.data.length` capeado            | `src/lib/tickets.ts:69`, `src/pages/Soporte.tsx:36-45` |
| 7  | 🟠  | Performance       | Métricas trae TODOS los tickets no-cerrados como rows enteros para contar — debería ser una vista SQL  | `src/pages/Metricas.tsx:73-90` |
| 8  | 🟠  | Realtime          | Sin subscription a tickets / agent_status — UI queda stale hasta F5 manual                             | `src/pages/Soporte.tsx:49-51` |
| 9  | 🟡  | Confirmaciones    | `window.confirm()` para acciones críticas (toggle tenant, bulk features) sin pedir tipear nombre       | `src/pages/Tenants.tsx:99`, `TenantFeaturesDetalle.tsx:93,105` |
| 10 | 🟡  | Performance       | `Tenants.load()` hace 3 queries × N tenants (locales + usuarios + sub) en `Promise.all` por fila      | `src/pages/Tenants.tsx:69-81` |
| 11 | 🟡  | UX                | `marcarResuelto` escribe directo `update({estado:'cerrado', agent_status:'resolved'})` sin RPC ni audit| `src/lib/tickets.ts:81-88` |
| 12 | 🟡  | UX                | `reabrirTicket` también update directo sin RPC. RLS lo permite, pero no audit                          | `src/lib/tickets.ts:115-122` |
| 13 | 🟡  | UX                | `setPrioridad` idem — update directo sin audit                                                          | `src/lib/tickets.ts:124-127` |
| 14 | 🟡  | UX                | "Marcar resuelto" del AgentPanel solo pregunta "¿mergeaste?" — no chequea estado real del PR en GitHub | `src/components/AgentPanel.tsx:38-49` |
| 15 | 🟡  | Data quality      | `marcarPagada` pasa `gateway_payment_id=null` siempre — perdés el ID externo del pago manual           | `src/pages/Pagos.tsx:166` |
| 16 | 🟡  | Auth              | Lookup de usuario por `auth_id` en cada onAuthStateChange — sin cache, sin debounce; OK hoy pero N+1  | `src/lib/auth.ts:39-43, 81-83` |
| 17 | 🟡  | UX                | `alert('Error: ...')` para errores de RPC — mensaje raw del Postgres sin traducir                       | varios (Tenants:101, Pagos:155,171, TicketDetail:45) |
| 18 | 🟡  | Bugs prone        | Filtro de `tickets` no debounce — al tipear en filtros, una request por render (no aplica búsqueda hoy)| `src/components/TicketsList.tsx` (no hay search input pero los Select disparan refetch via filters) |
| 19 | 🟡  | Bundle / lazy     | `App.tsx` importa todas las páginas eagerly (no lazy() + Suspense). Pesado para entry inicial         | `src/App.tsx:5-10` |
| 20 | 🟡  | Permission model  | Modelo es binario (superadmin o nada). No hay "soporte L1" o "billing-only" — todos pueden todo        | `src/lib/auth.ts:59-65` |
| 21 | 🟡  | Agent panel       | `agent_log` se muestra como JSON crudo en `<pre>` — sin viewer, sin filtros por evento                 | `src/components/AgentPanel.tsx:152-161` |
| 22 | 🟡  | Cache             | `useTenantFeatures` cachea 5min en sessionStorage. Si otro superadmin edita, caller no se entera      | `src/lib/useTenantFeatures.ts:11-12` |
| 23 | 🟢  | Datos sensibles   | Tickets exponen email del autor pero no teléfono / no tokens; screenshots por signed URL — bien        | `src/components/TicketDetail.tsx:107`, `tickets.ts:130-135` |
| 24 | 🟢  | CORS              | `crear-tenant.js` usa `setCorsHeaders` allow-list explícito (fix F2 auditoría)                         | `packages/pase/api/crear-tenant.js:33` |
| 25 | 🟢  | Push              | Web Push: VAPID + upsert + signed URL + bucket privado + SW con focus de tab existente                 | `src/lib/push.ts`, `public/sw-push.js` |
| 26 | 🟢  | Mobile            | Soporte.tsx tiene split-view responsive (lista xor detalle en mobile) + botón "atrás"                  | `src/pages/Soporte.tsx:76-100` |
| 27 | 🟢  | Login UX          | Login dedicado con mensajes claros por estado forbidden + autocomplete OK                              | `src/pages/Login.tsx`, `src/lib/auth.ts:45-65` |

## Top findings con código

### 🔴 #1 — "Ver como tenant" abre URL que PASE ignora

`src/pages/Tenants.tsx:88-95`:
```ts
const verComo = (t: TenantRow) => {
  // Override en sessionStorage del dominio PASE. Pero como estamos en otro
  // dominio (admin-console), no podemos escribir en su sessionStorage
  // directamente. Lo hacemos abriendo PASE con query param ?as=<tenant_id>
  // que PASE puede levantar en su entry.
  const url = `${PASE_API_BASE}/?as=${encodeURIComponent(t.id)}`;
  window.open(url, '_blank');
};
```

PASE NO lee `?as=` (verificado: `grep -rn "as=\|searchParams\.get\(.as.\)"` en `packages/pase/src/App.tsx` no devuelve nada relevante). El selector PASE solo lee `sessionStorage.pase_tenant_override__superadmin_only`, que es del origin PASE, no del admin-console.

Resultado: Lucas clickea "Ver", PASE abre en su tenant por defecto (Neko si está logueado ahí), nunca cambia al tenant target. Falsa sensación de que "ver como" funciona.

Fix recomendado: implementar en `packages/pase/src/App.tsx` un useEffect que lea `?as=<uuid>` al boot, valide superadmin, escriba `sessionStorage.pase_tenant_override__superadmin_only=<uuid>`, limpie el query param y reload. Sin esto el botón es teatro.

### 🟠 #2 — `toggleActivo` sin RPC ni audit

`src/pages/Tenants.tsx:97-103`:
```ts
const toggleActivo = async (t: TenantRow) => {
  const accion = t.activo ? 'Desactivar' : 'Activar';
  if (!confirm(`¿${accion} el tenant "${t.nombre}"?`)) return;
  const { error } = await db.from('tenants').update({ activo: !t.activo }).eq('id', t.id);
  if (error) { alert('Error: ' + error.message); return; }
  void load();
};
```

RLS `tenants_admin_write` permite el UPDATE porque el caller es superadmin (`202604281204_rls_etapa_3a_dual_policies.sql:450-452`), pero no hay trigger de audit en la tabla `tenants` ni RPC con `INSERT INTO auditoria`. Desactivar un tenant es un evento gordo (le rompe acceso a TODOS sus usuarios y procesos) — debería quedar registrado quién y cuándo, con motivo opcional.

Compará con `fn_set_tenant_feature` (línea 159-166 de la migration 202605270300) que sí audita cada toggle de feature. Misma severidad de evento, distinto tratamiento.

### 🟠 #3 — Método de pago via `prompt()` libre

`src/pages/Pagos.tsx:159-173`:
```ts
const marcarPagada = async (inv: InvoiceRow) => {
  const metodo = prompt('Método de pago (transferencia / efectivo / mercadopago / otro):', 'transferencia');
  if (!metodo) return;
  const notas = prompt('Notas opcionales:', '') || null;
  setActionLoading(`pay-${inv.id}`);
  const { error } = await db.rpc('fn_registrar_pago_invoice', {
    p_invoice_id: inv.id,
    p_metodo_pago: metodo,
    p_gateway_payment_id: null,
    p_notas: notas,
  });
```

Problemas combinados:
- Acepta cualquier string libre — "transf", "Transferencia", "TRANSFERENCIA bancaria con CBU 123" → todos válidos, todos distintos para `GROUP BY metodo_pago` después.
- `p_gateway_payment_id: null` siempre — si Lucas tiene el ID MP del pago manual, no hay dónde meterlo. Después la conciliación con MP queda colgada.
- `prompt()` nativo no se ve igual en mobile / iOS, sin ayuda contextual.

Fix: dropdown con valores enumerados + input opcional para `gateway_payment_id` + textarea para notas en un modal.

### 🟠 #4 — Faltan UI para borrar y restaurar tenant

Las RPCs `eliminar_tenant_completo` (migration `202605121400`, refactor robusto en `202605223200`) y `restore_tenant` (migration `202604281600`) existen en DB y son potentes — borrado dinámico que descubre tablas con `tenant_id` automáticamente.

`grep -rn "eliminar_tenant\|restore_tenant" packages/admin-console/src` devuelve **vacío**. Lucas hoy borra tenants ejecutando SQL scripts a mano (es lo que dice MEMORY: "eliminar_tenant_completo refactorizado a versión dinámica").

Riesgos del estado actual:
- Sin checkbox tipo "tipear el nombre exacto para confirmar".
- Sin preview de qué se va a borrar (cuántos movimientos, cuántas facturas, etc.).
- Sin botón restore visible si tocaste mal.
- Sin audit log fuerte que sobreviva al borrado.

### 🟠 #5 — Cero tests

`find packages/admin-console -name "*.test.*" -o -name "*.spec.*"` devuelve vacío. El `package.json` declara `"test": "vitest run"` pero no hay nada que correr.

Tests críticos faltantes:
- `useAuth()` con sesión válida / inválida / inactiva / rol != superadmin.
- Wizard de tenant: validaciones de cada paso, mapeo de errores, flow completo.
- `marcarPagada` con prompt vacío vs lleno.
- `fn_set_tenant_feature` con error de RPC (rollback de optimistic UI).
- Auth gate de `App.tsx` (redirect a Login si no es superadmin).

### 🟠 #7 — Métricas trae todos los tickets para contar

`src/pages/Metricas.tsx:73-90`:
```ts
const [{ data: m, error: mErr }, { data: t, error: tErr }] = await Promise.all([
  db.from('v_admin_metricas_tenants').select('*'),
  db.from('tickets_soporte')
    .select('tenant_id, estado')
    .neq('estado', 'cerrado'),
]);
// ...
for (const row of (t || []) as { tenant_id: string; estado: string }[]) {
  const c = counts.get(row.tenant_id) || { abiertos: 0, totales: 0 };
  c.totales++;
  if (row.estado === 'abierto') c.abiertos++;
  counts.set(row.tenant_id, c);
}
```

Hoy son <100 tickets así que pasa. A 10k tickets esta query baja 10k filas (~1MB de payload + 10k iteraciones JS) cuando lo que necesita es un `SELECT tenant_id, estado, count(*) FROM tickets_soporte WHERE estado != 'cerrado' GROUP BY 1,2`. Convertir a vista `v_tickets_open_por_tenant` o RPC dedicada.

### 🟡 #8 — Sin Realtime para tickets ni agent_status

`src/pages/Soporte.tsx:49-51`:
```ts
useEffect(() => {
  void loadList();
}, [loadList]);
```

Sin `db.channel(...).on('postgres_changes', ...)`. El agent auto-fix puede pasar `investigating → fixing → pr_opened` en pocos minutos, y el panel queda mostrando "En cola" hasta que Lucas presione F5 o cambie de pestaña. La idea de push notification compensa para usuarios desktop con browser abierto, pero el detalle de un ticket abierto en pantalla queda stale silenciosamente.

Fix: subscription a `tickets_soporte` filtrando por `selectedId`. Y opcional, una sub a la lista entera con polling de respaldo.

### 🟡 #14 — "Marcar resuelto" del AgentPanel solo confía en confirm()

`src/components/AgentPanel.tsx:38-49`:
```ts
async function onMarcarResuelto() {
  if (marcando) return;
  if (!window.confirm('¿Mergaste el PR en GitHub? Marcar como resuelto cierra el ticket.')) return;
  // ...
  const { error } = await marcarResuelto(ticket.id);
```

No chequea con GitHub API si el PR realmente fue mergeado. Lucas puede marcar como resuelto un PR no-mergeado y el ticket se cierra. El `agent_pr_url` + número PR ya están en DB, una llamada a `gh api repos/:owner/:repo/pulls/:n` con el GITHUB_TOKEN (que el agent ya usa) podría validar `merged_at != null` antes de cerrar.

### 🟡 #19 — Páginas no lazy en App.tsx

`src/App.tsx:5-10`:
```ts
import { Login } from './pages/Login';
import { Soporte } from './pages/Soporte';
import { Tenants } from './pages/Tenants';
import { TenantFeaturesDetalle } from './pages/TenantFeaturesDetalle';
import { TenantsFeaturesMatriz } from './pages/TenantsFeaturesMatriz';
import { Pagos } from './pages/Pagos';
import { Metricas } from './pages/Metricas';
```

Imports eager. La regla C8 de PASE (`pase-local/no-eager-page-import-app`) está en el `eslint.config.js` de packages/pase/comanda pero el comentario de `admin-console/eslint.config.js` (líneas 1-5) dice que no se replicaron porque "no toca tablas financieras". OK, no aplica security pero sí performance: con bundle de PASE creciendo, admin-console hoy importa 1500+ LOC al inicio para mostrar un login.

## Lo que está bien (no es finding, pero vale notarlo)

- **Auth gate robusto** — 4 estados explícitos + RLS dual cubren caso "user normal accede a admin-console URL".
- **Feature flags con audit y optimistic UI con rollback** — modelo limpio.
- **Wizard 4 pasos** con validaciones por paso y error mapping a español — buen UX para alta de tenant.
- **Push notifications completas** — VAPID + signed URL + bucket privado + SW que enfoca tab existente.
- **Mobile-friendly Soporte** — split-view responsive correcto con botón "atrás" para mobile.
- **CORS allow-list** en `crear-tenant.js` — fix F2 aplicado.
- **Sin endpoints propios** — superficie de ataque mínima, todo va por RLS.

## Recomendaciones priorizadas

1. **Arreglar verComo** (1h) — leer `?as=` en `packages/pase/src/App.tsx` y aplicar override. Sin esto el feature más grande de "ponerme en los zapatos del cliente" es ficción.
2. **Convertir `toggleActivo` a RPC `fn_set_tenant_activo` con audit** (30min) — patrón ya está en `fn_set_tenant_feature`.
3. **Modal de método de pago** (1h) — dropdown + input + textarea + soporte de `gateway_payment_id`. Reemplaza 2 `prompt()`.
4. **Agregar borrar/restore tenant a la UI** (3h) — modal "tipear nombre exacto" + preview + audit. Es lo que más le falta para no usar scripts.
5. **Tests del wizard + auth gate** (3h) — vitest + msw para mockear Supabase. Mejor coverage en la herramienta donde el costo de bug es altísimo.
6. **Vista SQL para contadores de Métricas** (1h) — `v_tickets_open_por_tenant` con `GROUP BY`. Sin esto la pantalla se cae a 10k tickets.
7. **Realtime en Soporte para `agent_status`** (2h) — sub al ticket seleccionado + refetch list on focus.
8. **Lazy imports en App.tsx** (15min) — `lazy(() => import(...))` + `<Suspense>`.
9. **Paginación en `listTickets()`** (1h) — `range(from, to)` + UI de "Cargar más" o paginador.

Total quick-wins: ~12h para llevar el admin console de 7/10 a 9/10.
