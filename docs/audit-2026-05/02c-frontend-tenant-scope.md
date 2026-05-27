# Fase 2C — Frontend tenant scope + endpoints serverless

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Método:** auditoría manual de `packages/*/api/`, `packages/pase/src/`, `packages/comanda/src/`, `packages/admin-console/src/`, migrations Storage RLS y RPCs `p_tenant_id`. Cruz-referencia contra ESLint rules `pase-local/require-apply-local-scope` y `no-direct-financiera-write`.

## 📊 Resumen ejecutivo

**18 endpoints serverless** auditados (`packages/pase/api/*.js` × 13 + `packages/instagram-bot/api/*.js` × 5). No hay `admin-console/api/` — el admin-console es una SPA sin endpoints propios.

| Categoría | Resultado |
|---|---|
| Endpoints con `SUPABASE_SERVICE_KEY` (bypassa RLS) | **18 de 18** (TODOS los serverless del repo) |
| Endpoints con auth de caller (`checkUserAuth`) | 11 |
| Endpoints con auth de cron (`checkCronAuth`) | 5 |
| Endpoints anónimos (webhooks / storefront) | 4 (`tienda-mp?action=preference\|webhook\|*-webhook\|notify-*`) |
| `SUPABASE_SERVICE_KEY` referenced en código de cliente (`src/`) | **0** (limpio — solo en comentarios docs) |
| RPCs con `p_tenant_id UUID` que validan vs `auth_tenant_id()` | 5 de 6 (todas las productivas hardenadas; 1 RPC interna de restore queda gated por superadmin) |
| Queries directas sobre tablas con `local_id` SIN `applyLocalScope` | 5 con `// eslint-disable -- motivo válido` documentado (importer empleados, importer saldos iniciales, lector facturas dup-check cross-local, bandeja entrada cross-local, widget comparativa) — todas legítimas |
| INSERT/UPDATE directos sobre tablas financieras desde frontend | 9 con `// eslint-disable C4-Fn -- deuda` documentadas en backlog |

### 🟢 Lo que está bien

- **Sin SERVICE_KEY filtrado en cliente.** El grep `SUPABASE_SERVICE_KEY|SERVICE_ROLE_KEY|service_role` sobre `packages/*/src/` devolvió 0 usos reales (solo 2 menciones en comentarios docs de `comanda/src/lib/afip/*`).
- **`pase_tenant_override__superadmin_only`** vive en `sessionStorage`, se lee solo en el frontend para hidratar el sidebar/dashboards, y NUNCA viaja al server. RLS sigue gateando por `auth.uid() → usuarios.tenant_id` del JWT. Como la fila `usuarios` del superadmin tiene `tenant_id IS NULL`, ya ve todos los tenants vía `auth_es_superadmin()` en las policies — el override es display-only. **Safe.**
- **Auditoría 21-may aplicó los CRIT-3 a CRIT-10**: `fn_cmv_real`, `fn_cmv_real_resumen`, `fn_revertir_stock_factura`, `fn_recalcular_stock_todos`, `fn_par_level_forecast` todas chequean `auth_tenant_id()` antes de devolver/mutar data por `p_tenant_id` recibido.
- **Auth helpers `_user-auth.js` y `_cron-auth.js`** son sólidos: el segundo fix CRIT-2 cerró el bug del `!Promise` siempre falsy + ALTO-2 fail-closed cuando falta `CRON_BEARER` en producción.
- **`auth-admin.js`** (CRIT-1 fix) ya impide creación cross-tenant + escalación de rol vía rank.
- **Storage RLS** funciona para paths `<tenant_id>/<file>`. El fallback "legacy → Neko" cubre los 7 archivos pre-multitenant.
- **COMANDA** usa anon key + RLS; las pantallas públicas (KDS, menú QR, tienda online, riders) pasan por RPCs `SECURITY DEFINER` que validan via `p_token`, no consultan tablas directo.
- **auth-bridge** del instagram-bot está deprecado (410 Gone) — el SSO bridge ya no se usa.

### ⚠️ Hallazgos confirmados

**6 críticos + altos accionables.** No encontré leaks masivos cross-tenant explotables sin auth, pero sí varios casos donde:
- un endpoint anónimo acepta IDs predecibles sin validar tenant del recurso → DoS / spoof,
- un endpoint con auth no escopa por tenant del caller → super-user de un tenant puede tocar data de otro,
- un upload a Storage usa path sin prefijo tenant → multi-tenant feature roto + leak legacy.

---

## 🎯 Ranking de findings

| # | Bug | Archivo:línea | Severidad |
|---|---|---|---|
| 1 | `tienda-mp?action=preference` anon sin verificar tenant de `venta_id` (BIGSERIAL enumerable) | `packages/pase/api/tienda-mp.js:121-214` | 🔴 CRÍTICO |
| 2 | `tienda-mp?action=rappi-webhook\|pedidosya-webhook` acepta `?local_id=N` en query sin validar firma HMAC → spoof unauth | `packages/pase/api/tienda-mp.js:315-464` (línea 348) | 🔴 CRÍTICO |
| 3 | `afip-cae` idempotency lookup sin filtrar por `tenant_id` → con UUID colisión/conocido leak CAE cacheado cross-tenant | `packages/pase/api/afip-cae.js:71-87` | 🔴 CRÍTICO (impacto bajo, vector raro pero data sensible) |
| 4 | `LectorFacturasIA.tsx` sube facturas a path `${id}.${ext}` sin prefijo tenant → bug multi-tenant: non-Neko NO puede subir + legacy fallback abre archivos a Neko | `packages/pase/src/pages/LectorFacturasIA.tsx:303-305` | 🔴 CRÍTICO |
| 5 | `mp-sync?reset=<local_id>` permite a cualquier `dueno/admin/superadmin` borrar `mp_movimientos` de OTRO tenant si conoce el `local_id` (`local_id` es INTEGER enumerable, sin filtro tenant) | `packages/pase/api/mp-sync.js:62-73` | 🟠 ALTO |
| 6 | `notif-pendientes-process.js` Path 2 acepta el `SUPABASE_SERVICE_KEY` literal como Bearer — si la key leakea (logs/repo), abre la cola de notifs entera | `packages/instagram-bot/api/notif-pendientes-process.js:51-52` | 🟠 ALTO |
| 7 | `refresh-tokens.js` deja entrar todo si `REFRESH_SECRET` env var es undefined (fail-open) — mismo bug que `_cron-auth.js` antes del fix ALTO-2 | `packages/instagram-bot/api/refresh-tokens.js:36-43` | 🟠 ALTO |
| 8 | `Blindaje.tsx` sube a `${local_id}/${tipo}_...` sin tenant prefix → tenants nuevos no podrán subir documentos blindaje | `packages/pase/src/pages/herramientas/Blindaje.tsx:194-196` | 🟠 ALTO |
| 9 | `mp-process.js` itera todas las `mp_credenciales` activas sin scoping a tenant del trigger (si el caller no es cron sino user JWT) | `packages/pase/api/mp-process.js:51-54` | 🟡 MEDIO |
| 10 | `tienda-mp?action=webhook` itera todas las creds MP de todos los tenants para encontrar match → side-channel de visibilidad cross-tenant (timing) | `packages/pase/api/tienda-mp.js:240-267` | 🟡 MEDIO |
| 11 | `diagnostic.js` expone `first4/last4/length` de TODOS los secrets del bot a cualquier `dueno/admin`/superadmin de cualquier tenant — debe ser superadmin-only | `packages/instagram-bot/api/diagnostic.js:51-78` | 🟡 MEDIO |
| 12 | Storage RLS bucket `facturas`: paths legacy (sin UUID prefix) caen a Neko — si Lector IA o Blindaje suben sin tenant prefix, fail-open hacia Neko | `packages/pase/supabase/migrations/202604281208_storage_rls_multitenant.sql:39-156` | 🟡 MEDIO |
| 13 | `tienda-mp?action=notify-pedido\|listo\|rechazado\|entregado` acepta `venta_id` anon — con `email_destinatario` puede usarse para enumerar ventas o (fix ALTO-3 mitiga) spam dirigido. Sigue exponiendo metadata: cliente_nombre, número local, total | `packages/pase/api/tienda-mp.js:467-750` | 🟡 MEDIO |
| 14 | `backup-tenants.js` cualquier `dueno/admin` de un tenant puede disparar backup global (escribe a bucket de TODOS los tenants) — DoS de recursos serverless + storage quota; data en sí cae al bucket correcto por tenant prefix | `packages/pase/api/backup-tenants.js:77-216` | 🟢 BAJO |
| 15 | `admin-console verComo` abre PASE con `?as=<tenant_id>` que **no está implementado** en PASE main.tsx — UX rota, no security issue | `packages/admin-console/src/pages/Tenants.tsx:88-95` | 🟢 BAJO (UX bug, no security) |

---

## 🔴 CRÍTICOS — detalle

### 1. `tienda-mp?action=preference` anon + venta_id enumerable

**Archivo:** `packages/pase/api/tienda-mp.js:121-214`

```js
async function handlePreference(req, res) {
  const { venta_id, items, total, back_url_success } = req.body || {};
  ...
  const { data: venta } = await supabase
    .from('ventas_pos').select('id, local_id, tenant_id, total, estado, cliente_nombre, cliente_telefono')
    .eq('id', venta_id).single();
  // ↑ NO valida que el caller pueda operar sobre esa venta.
  ...
  const { data: cred } = await supabase.from('mp_credenciales')
    .select('id, activa').eq('local_id', venta.local_id).eq('activa', true)...;
  // Genera preference MP contra credencial del otro tenant.
```

- `ventas_pos.id` es `BIGSERIAL` (migration `202605051800_comanda_sprint_2.sql:186`) → trivialmente enumerable.
- Atacante anónimo puede:
  - Iterar IDs y obtener `cliente_nombre`, `cliente_telefono`, `total` del response (status 200 cuando exitoso, mensajes distintos para 404/409 — side-channel claro de "venta existe").
  - Generar preferences MP contra cuentas de otros tenants (consume cuota MP del competidor, ensucia su panel con cobros falsos).

**Fix:**
- Mover preference behind auth. Si tiene que ser anon (cliente final pagando), validar firma HMAC short-lived emitida server-side al crear la venta + incluir `tenant_id` en el secret.
- Mientras tanto: 410 si `venta.estado != 'pendiente'` o si el venta_id no fue creado por la propia tienda online (chequear `origen` o algo).

### 2. `tienda-mp?action=*-webhook` acepta `?local_id` en query (spoof unauth)

**Archivo:** `packages/pase/api/tienda-mp.js:315-464` (línea 348)

```js
let localId = Number(req.query.local_id) || null;     // ← override anon
if (!localId && externalLocalId) {
  const { data: mapeo } = await supabase.from('mapeos_locales_externos')...;
  if (mapeo) localId = mapeo.local_id;
}
```

- Comment dice "modo testing/dev" pero el código está en producción.
- HMAC verifier importado pero NOT wired (`void verifyRappiWebhookSignature` línea 1628).
- Atacante POSTea a `/api/tienda-mp?action=rappi-webhook&local_id=<X>` con cualquier payload → crea `ventas_pos` en estado `necesita_aprobacion` en el local X. Causa: ruido en POS del local víctima, posible cobro accidental si encargado aprueba sin chequear.

**Fix:**
- Borrar la rama `Number(req.query.local_id)` — solo el mapeo desde DB.
- Wire HMAC: `verifyRappiWebhookSignature(rawBody, req.headers['x-signature'], creds.secret)` antes de procesar.
- Hasta que haya HMAC, 400 si no hay mapeo registrado.

### 3. `afip-cae` idempotency lookup sin filtro de tenant

**Archivo:** `packages/pase/api/afip-cae.js:71-87`

```js
const { data: prev } = await supabase
  .from('afip_facturas')
  .select('id, cae, cae_vence_at, numero, qr_fiscal_url, estado, rechazo_motivo')
  .eq('request_uuid', body.request_uuid)
  .maybeSingle();
if (prev?.cae) {
  return res.status(200).json({ factura_id: prev.id, cae: prev.cae, ... cached: true });
}
```

- UUIDs son astronómicamente improbables de colisionar accidentalmente, pero el endpoint NO chequea que `prev.tenant_id === tenantId`.
- Si un atacante de Tenant B aprende un `request_uuid` que Tenant A usó (filtrado por logs, network capture, etc.), puede hacer un POST con ese UUID y recibir el CAE/QR fiscal completo de Tenant A — data fiscal real cacheada.

**Fix:** agregar `.eq('tenant_id', tenantId)` al `select` de prev.

### 4. `LectorFacturasIA.tsx` sube sin prefijo tenant

**Archivo:** `packages/pase/src/pages/LectorFacturasIA.tsx:303-305`

```js
const ext = (archivo.name.split(".").pop()||"bin").toLowerCase();
const path = `${id}.${ext}`;                          // ← sin prefijo tenant
const { error: upErr } = await db.storage.from("facturas").upload(path, archivo, ...);
```

- Storage RLS de migration `202604281208_storage_rls_multitenant.sql` exige path con prefijo `<tenant_id>/...` O fallback legacy "solo Neko".
- Resultado actual:
  - Tenants NEKO → upload OK (fallback legacy), lectura OK (fallback legacy).
  - Tenants NUEVOS → **upload rechazado por RLS** → bug operativo: feature roto multi-tenant.
- Si en el futuro un tenant nuevo logra subir (por bypass / cambio de policy), el archivo aparece en el bucket sin scoping y RLS permite a Neko leerlo.

**Fix:** `const path = \`${user.tenant_id}/${id}.${ext}\`;` (mismo patrón que `RRHHLegajo.tsx:356-357` que sí lo hace bien).

---

## 🟠 ALTOS — detalle

### 5. `mp-sync?reset=<local_id>` cross-tenant delete

**Archivo:** `packages/pase/api/mp-sync.js:62-73`

```js
for (const lid of resetIds) {
  const { error: delErr, count } = await db
    .from('mp_movimientos')
    .delete({ count: 'exact' })
    .eq('local_id', lid);     // ← sin filtro tenant
  ...
}
```

- `checkCronAuth` autoriza a cualquier `dueno/admin/superadmin` de cualquier tenant.
- `local_id` es INTEGER global enumerable.
- Atacante (dueño legítimo de Tenant A) descubre el `local_id` de Tenant B (es trivial — está en la URL de PASE cuando se selecciona un local) → `POST /api/mp-sync?reset=<otro_local_id>` borra todos los `mp_movimientos` del local del competidor → próxima sync los re-importa (ventana 7d), pero **pierde permanentemente** todo lo de >7d. Daño económico real.

**Fix:** validar que `local_id` pertenezca al `tenant_id` del caller antes del delete. O bloquear `?reset` para callers user-jwt y permitirlo solo via `CRON_BEARER`.

### 6. `notif-pendientes-process.js` acepta SUPABASE_SERVICE_KEY como Bearer

**Archivo:** `packages/instagram-bot/api/notif-pendientes-process.js:49-52`

```js
const auth = (req.headers.authorization || ...).replace(/^Bearer /, '');
let authorized = false;
if (CRON_BEARER && auth === CRON_BEARER) authorized = true;
else if (SUPABASE_SERVICE_KEY_ENV && auth === SUPABASE_SERVICE_KEY_ENV) authorized = true;   // ← peligroso
```

- La `SUPABASE_SERVICE_KEY` es la llave maestra del Postgres — leak total si se filtra.
- Reusarla como Bearer token aumenta superficie: GitHub Actions logs, Vercel logs, mistyped env-var swap puede exponerla en places donde solo el cron token debería estar.
- Defense-in-depth violado.

**Fix:** borrar Path 2. Si el cron del bot necesita su propio bearer, definir `BOT_CRON_BEARER` y usarlo.

### 7. `refresh-tokens.js` fail-open si `REFRESH_SECRET` no seteado

**Archivo:** `packages/instagram-bot/api/refresh-tokens.js:36-43`

```js
if (REFRESH_SECRET) {           // ← si no está seteada, skip auth
  const secret = req.headers['x-refresh-secret'];
  if (secret !== REFRESH_SECRET) return res.status(401)...;
}
// (cae acá sin auth si REFRESH_SECRET undefined)
```

- Mismo bug que `_cron-auth.js` tenía pre-ALTO-2 fix.
- Si la env var se borra accidentalmente en Vercel → endpoint queda abierto → cualquiera puede gatillar refresh de TODOS los tokens IG de TODOS los tenants. Side effect: si el refresh falla, marca cuentas como `desconectado_at` y `bot_activo=false` → DoS de bots IG cross-tenant.

**Fix:** fail-closed.
```js
if (!REFRESH_SECRET) return res.status(500).json({ error: 'REFRESH_SECRET_NOT_CONFIGURED' });
if (secret !== REFRESH_SECRET) return res.status(401)...;
```

### 8. `Blindaje.tsx` sube sin prefijo tenant

**Archivo:** `packages/pase/src/pages/herramientas/Blindaje.tsx:194-196`

```js
const path = `${lid}/${tipo.id}_${yyyymmdd}.${ext}`;  // lid es local_id, no tenant_id
const { error: upErr } = await db.storage.from("blindaje").upload(path, archivo, ...);
```

- Mismo problema que el #4. Multi-tenant roto: tenants nuevos no podrán subir.

**Fix:** `const path = \`${user.tenant_id}/${lid}/${tipo.id}_${yyyymmdd}.${ext}\`;` o mover lid dentro del prefijo tenant.

---

## 🟡 MEDIOS — detalle abreviado

### 9. `mp-process.js` itera todas las creds activas

Mismo patrón que mp-sync. Si el caller es user JWT (no cron), no debería tocar creds de otros tenants. Filtrar `creds` por `tenant_id` del caller si auth path != cron.

### 10. `tienda-mp?action=webhook` probe cross-tenant

```js
const { data: creds } = await supabase.from('mp_credenciales').select('id').eq('activa', true);
// itera TODAS las creds buscando match → side-channel timing/order leak
for (const c of creds) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { Authorization: `Bearer ${token}` });
  if (r.ok) { payment = await r.json(); break; }
}
```

Después del `break`, busca `ventas_pos` por `external_reference = payment.external_reference`. Si esa venta es de otro tenant, paga la venta del otro tenant (la RPC `fn_cobrar_venta_comanda` debería bloquear con tenant check, validar).

### 11. `diagnostic.js` expone secret previews a todos los dueño/admin

Cualquier `dueno/admin/superadmin` de **cualquier tenant** ve `first4`+`last4`+`length` de IG_APP_SECRET, ANTHROPIC_API_KEY, REFRESH_SECRET, META_APP_SECRET, SUPABASE_SERVICE_KEY. Aunque enmascarado, ayuda a un atacante con candidato de credencial a confirmar.

**Fix:** chequear `usuario.rol === 'superadmin'` en lugar de `'dueno'/'admin'`.

### 12. Storage RLS legacy fallback a Neko

Por design — pero combinado con #4 y #8, cualquier tenant que se onboarde y al que se le rompa el upload tendrá experiencia degradada. A largo plazo: cerrar el fallback "legacy → Neko" cuando todos los archivos legacy estén migrados a prefijo `<neko_uuid>/`.

### 13. `tienda-mp?action=notify-*` exponen metadata sin auth

Aunque ALTO-3 fix mitigó el envío de email a destinatarios arbitrarios, los endpoints siguen aceptando `venta_id` anon y devolviendo distinto status según existencia (404 vs 200). Permite enumeration de ventas. Y el response del flow exitoso al menos confirma que la venta existe + leak nombre del local en el email.

---

## 🟢 BAJOS — detalle abreviado

### 14. `backup-tenants.js` cualquier dueño dispara backup global

`checkCronAuth` permite `dueno/admin`. Un `dueno` de tenant chico puede disparar backup que itera 35 tablas × N tenants × cada vez que quiera. Consume cuota Vercel + storage. Data en sí va al bucket correcto (con prefijo tenant), no leak directo.

**Fix:** restringir backup-tenants y backup-cleanup a `superadmin` o solo `CRON_BEARER`.

### 15. `admin-console verComo` query `?as=` no implementado

```ts
const url = `${PASE_API_BASE}/?as=${encodeURIComponent(t.id)}`;
window.open(url, '_blank');
```

Grep en `packages/pase/src/` por `?as=` / `get("as")` / `searchParams.get('as')` → cero matches. PASE no lo levanta. Feature de "Ver como" del admin-console NO funciona. No es security, es UX rota.

---

## 📋 Patrones generales observados

1. **`SUPABASE_SERVICE_KEY` se usa correctamente** — solo en `api/*.js`. Cliente está limpio.
2. **`checkUserAuth` + `checkCronAuth` son sólidos** post-fixes de la auditoría 21-may. La regresión de las dos llamadas sin `await` (CRIT-2) se fixeó en backup-cleanup + backup-tenants.
3. **RPCs con `p_tenant_id` están casi 100% guardadas** vía `IF p_tenant_id IS DISTINCT FROM auth_tenant_id() AND NOT auth_es_superadmin() THEN RAISE 'TENANT_MISMATCH'`. Patrón consistente, fácil de replicar en RPCs nuevas. CRIT-3 ya cerrado.
4. **Storage RLS** depende de paths con prefijo `<tenant_id>/...`. **Solo 1 de 4 callsites del frontend lo respeta** (`RRHHLegajo.tsx`). Los otros 3 (Lector IA, Blindaje, SoporteWidget) NO. Multi-tenant roto en esas features para tenants nuevos.
5. **Webhooks de partners (Rappi/PedidosYa/Deliverect) sin HMAC**. Riesgo: aceptar payloads spoofed. Atenuado porque generan `ventas_pos` en estado `necesita_aprobacion` que el operador revisa, pero abre vector para envenenar el inbox del POS.
6. **Endpoints de notify (`tienda-mp?action=notify-*`)** son anónimos y exponen metadata de ventas. El fix ALTO-3 cerró el spam pero el enumeration sigue. Aceptable por design (cliente final puede recibir email) pero consider rate-limit por IP.
7. **Override `pase_tenant_override`** está bien diseñado: display-only, no afecta RLS. Pero el comentario "Solo superadmin lee/escribe esta key" es solo convención client-side — sessionStorage es manipulable. La defensa real es que el server NUNCA lee `tenant_id` del body para queries (siempre desde JWT).

---

## 📁 Archivos relevantes

- **Endpoints serverless inspeccionados:**
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\auth-admin.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\auth-change-password.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\claude.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\crear-tenant.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\afip-cae.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\tienda-mp.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\mp-sync.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\mp-process.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\mp-generate.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\mp-update-pending-releases.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\backup-tenants.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\backup-cleanup.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\_user-auth.js`
  - `C:\Users\lucas\Documents\PASE\packages\pase\api\_cron-auth.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\webhook.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\send.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\refresh-tokens.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\oauth-callback.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\diagnostic.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\notif-pendientes-process.js`
  - `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\auth-bridge.js` (deprecated 410)

- **Migrations clave:**
  - `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202604281200_tenants_foundation.sql` — `auth_tenant_id()`, `auth_es_superadmin()`.
  - `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202604281208_storage_rls_multitenant.sql` — Storage RLS dual-mode (tenant prefix + Neko fallback).
  - `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605212200_auditoria_criticos.sql` — CRIT-3/4/5 fixes (fn_cmv_real, fn_revertir_stock_factura, fn_recalcular_stock_todos).
  - `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605240500_fix_fn_cmv_real_resumen_fecha.sql` — fn_cmv_real_resumen guard mantenido.
  - `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202604281600_rpc_restore_tenant.sql` — superadmin-only restore.

- **Frontend Storage upload sites (3 con bug, 1 OK):**
  - 🔴 `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\LectorFacturasIA.tsx:305` — sin tenant prefix
  - 🟠 `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\herramientas\Blindaje.tsx:195` — usa local_id en vez de tenant_id
  - 🟢 `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\RRHHLegajo.tsx:356` — correcto, usa `${user.tenant_id}/...`
  - 🟢 `C:\Users\lucas\Documents\PASE\packages\pase\src\components\SoporteWidget.tsx:127` — bucket `soporte-screenshots`, fuera del scope tenant RLS (bucket de soporte global)

- **Auth helpers:**
  - `C:\Users\lucas\Documents\PASE\packages\pase\src\lib\auth.ts` — `applyLocalScope`, `scopeLocales`, `auth_es_dueno_o_admin` client-side.
  - `C:\Users\lucas\Documents\PASE\packages\pase\src\App.tsx:142` — `TENANT_OVERRIDE_KEY` constant + handling.
