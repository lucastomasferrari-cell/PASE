# 05c — Auditoría COMANDA Integraciones (AFIP, Delivery, Tienda, KDS, QR, Print, Riders)

Fecha: 2026-05-27 · Scope: módulos WIP COMANDA — `packages/comanda/src/lib/afip/*`, `packages/comanda/src/pages/{Tienda,MenuQr,Kds,Integraciones,Rider,Online}/*`, `packages/comanda/src/services/{printerService,printAgentsService,kdsService,kdsTokensService,menuQrService,menuQrTokensService,ridersService,integracionesService}.ts`, `packages/comanda/src/lib/{escpos/printer,printServer/client}.ts`, `packages/pase/api/{afip-cae.js,tienda-mp.js,_rappi.js,_pedidosya.js,_mp-token.js,_user-auth.js}`.

## Resumen ejecutivo

Estado real:
- **AFIP** — endpoint emisor está bien diseñado (JWT auth + idempotency por `request_uuid` + cert/key restringido a `service_role`). Maneja NC con `CbtesAsoc`, QR fiscal AR según RG 4892/2020, fallback de estado `rechazada`. **Falla crítica de recovery**: si la fila `afip_facturas` no se inserta después de obtener CAE, el `request_uuid` queda libre → próxima retry pide CAE nuevo a AFIP (numero distinto), generando **factura duplicada en AFIP que no existe en DB**. Marca `warning: 'CAE_EMITIDO_PERO_NO_PERSISTIDO'` pero no escribe nada del CAE en ningún lado — perdido al refresh.
- **Tipo de comprobante hardcoded a IVA 21%** (`Id: 5`) — local con productos con 10.5% (carne, frutas) o exento sufrirá rechazo o calcula mal. No hay validación de CUIT del cliente para tipo A.
- **Delivery (Rappi/PedidosYa)** — el webhook receptor (`handlePartnerWebhook`) **NO valida firma HMAC** (los helpers `verifyRappiWebhookSignature`/`verifyPedidosYaWebhookSignature` existen pero están desconectados — `void verifyRappiWebhookSignature;` al final del archivo). Cualquiera con la URL del webhook puede inyectar pedidos fantasma. **NO maneja idempotency de webhooks** — si Rappi reenvía (lo hace), genera ventas duplicadas. La unique constraint `uniq_ventas_external_order` causaría 500 → Rappi reintenta infinito.
- **Tienda + MP** — `handleWebhook` (MP) tampoco valida firma `x-signature`, TODO desde hace tiempo. El loop "probar todas las credenciales activas" es O(N) sobre **todos los tenants del sistema** — un payment lookup itera todas las creds MP activas en la DB hasta encontrar match (leak cross-tenant de patrón de uso + costo elevado).
- **KDS** — tokens son UUIDs largos pero **sin expiración ni rotación**. Una vez impreso/foto del QR sale del local, alguien puede leer todas las comandas indefinidamente. Polling 30s OK; sin Realtime visible en el código — el comentario dice "los tickets nuevos van por Realtime" pero `KdsView.tsx` no llama `useRealtimeTable`.
- **Menú QR** — mismos tokens sin TTL ni rotación. Pricing es live (RPC SECURITY DEFINER lee `items.precio_madre`). Imágenes NO optimizadas (se sirve `foto_url` directa sin redimensionado/CDN). Botón "Llamar mozo" es **stub** (admite "Avisamos al mozo" pero no notifica nada).
- **MP local creds** — gestionado solo en PASE (`mp_credenciales` con encryption RPC `set_mp_token`/`get_mp_token`). En COMANDA NO hay UI nueva — usa la misma tabla y el formulario está solo en PASE. El `mp_qr_url` en `comanda_local_settings` se guarda como **texto plano** sin cifrado (no es un token, es URL pública del QR; OK).
- **Print agent** — heartbeat HTTP cada 60s con `agent_token` plain como auth. Print server local en `http://127.0.0.1:9100` **sin auth** — cualquier proceso local puede imprimir en cualquier impresora del comerciante. Idempotency key opcional. `abrirCajon` solo soportado vía WebUSB (deuda explícita). No hay auto-update del binario (no se ve en el código del repo COMANDA — vive afuera).
- **Riders** — token público en URL `/r/:token` para PWA. `actualizarPosicionRider` y `toggleRiderOnline` van por `dbAnon` (anon key) sin rate limiting visible — un script puede spammear posiciones. Wake lock + battery + intervalo 30s implementado. Mini-mapa con Leaflet OK.
- **Patrones cross**: no hay sistema central de logs/eventos tipo `ig_eventos` — cada flow guarda errores en columnas específicas (`afip_facturas.rechazo_motivo`, `integraciones_externas_credenciales.last_error`, `pedidos_externos_log.payload`). No hay retry con backoff exponencial — los reintentos son manuales o vía reintento del partner.

## Tabla findings por severidad

| # | Sev | Área | Item | Archivo:línea |
|---|---|---|---|---|
| 1 | 🔴 | Webhook delivery | Firma HMAC no validada (comentario "// TODO: validar firma") | `tienda-mp.js:222-225, 333-334, 1628-1629` |
| 2 | 🔴 | AFIP | Recovery roto: si INSERT falla post-CAE, próxima retry pide CAE nuevo → factura duplicada en AFIP | `afip-cae.js:254-271` |
| 3 | 🔴 | Webhook delivery | Sin idempotency por `external_order_id` — Rappi reenvíos crean ventas duplicadas o 500 infinito | `tienda-mp.js:402-419` |
| 4 | 🔴 | MP webhook | Loop O(N) sobre TODOS los tenants para resolver payment → leak cross-tenant + costo elevado | `tienda-mp.js:240-262` |
| 5 | 🔴 | Print server | `http://127.0.0.1:9100` sin auth — cualquier proceso local imprime | `printServer/client.ts:7, 113-131` |
| 6 | 🟠 | AFIP | `Id: 5` (21%) hardcoded — productos al 10.5% / 27% / exentos rompen | `afip-cae.js:140-144` |
| 7 | 🟠 | AFIP | Sin validación CUIT del cliente para Factura A (tipo 1) | `afip-cae.js:163-184, types.ts` |
| 8 | 🟠 | AFIP | Cert vencimiento parseado client-side pero no hay alerta proactiva en UI | `service.ts:96-153` |
| 9 | 🟠 | KDS / QR | Tokens sin TTL, sin rotación, sin scope binding (IP/UA) | `kdsTokensService.ts:24-68`, `menuQrTokensService.ts:24-73` |
| 10 | 🟠 | KDS | Realtime claimed in code comment pero NO está implementado | `KdsView.tsx:11-13, 68-73` |
| 11 | 🟠 | Rappi/PeYa import | OAuth token cache en memoria de la function → cold start = nuevo token cada vez; sin persistencia | `_rappi.js:28, 73`, `_pedidosya.js:24, 62` |
| 12 | 🟠 | Webhook partner | Match de items por `ilike '%nombre%'` → false positives groseros (e.g. "Coca" matchea "Coca Zero") | `tienda-mp.js:434-438` |
| 13 | 🟠 | Webhook partner | `numero_local = Date.now()%100000` — race conditions con tickets manuales del POS | `tienda-mp.js:405` |
| 14 | 🟠 | Tienda checkout | URL `notificationUrl` hardcoded a `pase-yndx.vercel.app` aunque sea preview / dominio custom | `tienda-mp.js:167` |
| 15 | 🟠 | Riders | `dbAnon` RPC `fn_actualizar_posicion_rider` sin rate limiting → DoS / spam GPS posible | `ridersService.ts:161-183` |
| 16 | 🟠 | Rappi/PeYa import | `OR` con texto sin escape en filtro (`sku_rappi.eq.X,nombre.eq.Y`) — falla con SKUs con comas/comillas | `tienda-mp.js:1206-1213, 1482-1489` |
| 17 | 🟡 | Print agent | `agent_token` plain (no hashed) en DB; revocación es soft delete (token leaked sigue válido si se restaura) | `tienda-mp.js:774-779, 784-786` |
| 18 | 🟡 | AFIP | Tipo `concepto=1` (Productos) implícito — para servicios necesita 2/3 + `FchServDesde`/`Hasta` que ni se pasan | `afip-cae.js:168, 164-184` |
| 19 | 🟡 | Tienda MP | Comparación `Math.abs(venta.total - total) > 0.5` — tolerancia de 50¢ es razonable pero arbitraria, no documentada | `tienda-mp.js:143` |
| 20 | 🟡 | Print server | Sin retry/backoff si `print` falla — solo failover a WebUSB; queue impresión queda en limbo en el server | `printerService.ts:96-118` |
| 21 | 🟡 | Print agent | Heartbeat sin chequeo de versión mínima del agent — agent con bug viejo sigue corriendo | `tienda-mp.js:768-818` |
| 22 | 🟡 | KDS | Sin protección contra fast-double-tap en `marcarListo` — botón sigue clickeable mientras vuela el request | `KdsView.tsx:283-292` |
| 23 | 🟡 | Menú QR | Imágenes `foto_url` sin redimensión/CDN — móviles cargan JPG full-res | `MenuQrView.tsx:182-198` |
| 24 | 🟡 | Menú QR | "Llamar mozo" stub silencioso pero muestra toast "Avisamos al mozo" → mentira UX | `MenuQrView.tsx:124-127` |
| 25 | 🟡 | Webhook partner | `pedidos_externos_log` se inserta dentro de un try/catch silenciado — falla silenciosa, no se ve en logs | `tienda-mp.js:322-331` |
| 26 | 🟡 | Rider PWA | watchPosition + setInterval pueden quedar huérfanos si componente se rmonta sin pasar por toggle | `RiderPWA.tsx:169-206, 232` |
| 27 | 🟡 | Rappi/PeYa | Cancel/dispatch sin idempotency key — doble click envía dos veces a partner | `tienda-mp.js:1067-1094, 1534-1561` |
| 28 | 🟡 | Tienda MP | `preference` no enviá `metadata` con `local_id`/`tenant_id` — webhook necesita iterar todas las creds | `tienda-mp.js:169-191` |
| 29 | 🟡 | ESC/POS | CP437 hard-coded reemplaza ñ→n, á→a — tickets sin acentos AR (UX feo) | `escpos/printer.ts:73-81` |
| 30 | 🟢 | AFIP | Parser X.509 propio frágil (busca pattern `0x17 0x0D` sin ASN.1 real) — fail silente en certs nuevos | `service.ts:96-153` |
| 31 | 🟢 | AFIP | Comentario "Token cache no persiste en cold start" — aceptable, pero ya hay >50 facturas/mes → considerar Storage cache | `afip-cae.js:111-115` |
| 32 | 🟢 | KDS | Token va en query string (`?token=...`) — queda en logs/proxies de la tablet/router | `KdsView.tsx:37` |
| 33 | 🟢 | Tienda | `crypto.randomUUID` fallback inseguro (`Math.random`) — para idempotency aceptable, no para tokens | `MenuQrView.tsx:108-110`, `kdsTokensService.ts:24-29`, `menuQrTokensService.ts:24-28` |
| 34 | 🟢 | Print agent | Cap arbitrario `metadata.printers.slice(0, 20)` — local con >20 impresoras pierde info | `tienda-mp.js:805` |
| 35 | 🟢 | Webhook delivery | `mapeo` lookup no usa cache — 1 query DB por webhook. Volumen bajo, low impact | `tienda-mp.js:350-356` |

## Detalle de findings top

### 🔴 1 — Webhook delivery: firma HMAC desconectada
`packages/pase/api/tienda-mp.js:1628-1629`
```js
void verifyRappiWebhookSignature;
void verifyPedidosYaWebhookSignature;
```
Los helpers existen en `_rappi.js:185-195` y `_pedidosya.js:153-161`, **funcionan correctamente** (HMAC-SHA256, `timingSafeEqual`), pero NO se invocan en `handlePartnerWebhook`. Comentario línea 333: `// TODO: validar firma HMAC del partner (cuando se tenga la credencial). Por ahora aceptamos cualquier POST.`

Impacto: cualquier atacante con la URL del webhook (que es pública y se copia desde `ConectarPartners.tsx`) puede:
- Crear ventas fantasma en estado `necesita_aprobacion` (mapeadas al local víctima vía `external_local_id` que se puede enumerar por brute force).
- Spam DoS de la cola `/pos/pedidos`.
- Si el cajero aprueba sin mirar, comida real preparada gratis.

Fix: en `handlePartnerWebhook` antes de cualquier insert, traer `webhook_secret` del row `integraciones_externas_credenciales.credentials.webhook_secret` y llamar `verifyRappiWebhookSignature(req, secret)`. Si `false` → `401`. Apenas Lucas tenga la cred real, el secret se carga y se activa.

### 🔴 2 — AFIP recovery roto post-CAE
`packages/pase/api/afip-cae.js:254-271`

Si `getLastVoucher` + `createVoucher` ya pegaron contra AFIP (numero asignado + CAE emitido), y después el `INSERT afip_facturas` falla (red, RLS, constraint), el endpoint devuelve `200` con `warning: 'CAE_EMITIDO_PERO_NO_PERSISTIDO'` pero:
- El frontend descarta el warning silenciosamente (en `client.ts:43-75` no se chequea `warning`).
- El `request_uuid` queda libre — próxima retry sigue por la rama "no existe prev" y pide otro CAE → AFIP asigna OTRO numero → ahora hay 2 facturas en AFIP que no aparecen en tu DB.

Esto en AR es un problema serio: la factura existe fiscalmente, el cliente puede pedirla, vos no tenés copia ni IVA registrado.

Fix:
1. INSERT debe ir **antes** del `createVoucher` con estado `'pendiente'` + `request_uuid` reservado. Si AFIP devuelve OK, UPDATE estado→`'aprobada'` + CAE. Si falla createVoucher → UPDATE estado→`'rechazada'`.
2. Idempotency check (línea 74-79) debe incluir filas con estado `'pendiente'` y `cae IS NULL` — si la encuentra, NO pedir CAE de nuevo, devolver el "numero" pre-reservado y registrar el caso para revisión manual.
3. Considerar `RPC fn_emitir_factura_atomica` que reserve numero+request_uuid en transacción ANTES de pegar AFIP.

### 🔴 3 — Webhook idempotency: `external_order_id` sin pre-check
`packages/pase/api/tienda-mp.js:402-419`

Existe `UNIQUE INDEX uniq_ventas_external_order ON ventas_pos(external_provider, external_order_id) WHERE external_order_id IS NOT NULL` (migration `202605200600`).

Pero el handler hace `INSERT ... external_order_id: externalOrderId` directo sin chequear duplicate. Cuando Rappi reenvía (típico cada 30s hasta recibir 200), el segundo INSERT falla con `23505` (unique violation), el handler entra al `if (errVenta) { res.status(500) }` línea 421-425, Rappi vuelve a reintentar indefinidamente.

Fix: antes del INSERT, `SELECT id FROM ventas_pos WHERE external_provider=$1 AND external_order_id=$2`; si existe → `200 { ok: true, venta_id: existing, deduped: true }`. Cubre tanto reenvíos benignos como retries por timeout del partner.

### 🔴 4 — MP webhook itera TODOS los tenants
`packages/pase/api/tienda-mp.js:240-262`

```js
const { data: creds } = await supabase.from('mp_credenciales').select('id').eq('activa', true);
for (const c of creds) {
  const token = await getToken(c.id);
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {...});
  if (r.ok) { payment = await r.json(); break; }
}
```

Para resolver `payment.external_reference`, el webhook itera todas las credenciales MP activas del sistema entero (no del tenant) y hace 1 API call a MP por cada una hasta encontrar match. Con N tenants, hace ~N/2 calls promedio + N `get_mp_token` desencripciones.

Impactos:
- **Performance**: 10 tenants × 200ms = 2s por webhook. MP timeout es 22s pero todo lo que tarde >5s genera "delivery failure" retries.
- **Leak cross-tenant**: el orden de tenants en el loop + los `404` de MP de tenants que no tienen ese pago revelan implícitamente patrones (oracle attack si querés ser paranoico).
- **Cost**: MP rate limits son ~1000/min por cred. En spike de cobros, podés meterte en throttling de tenants ajenos.

Fix preferido: agregar `metadata: { local_id, tenant_id, mp_credencial_id }` al body de `preference` (línea 169-191), MP los devuelve en el webhook payload. Lookup directo por `mp_credencial_id`, 1 call.

### 🔴 5 — Print server local sin auth
`packages/comanda/src/lib/printServer/client.ts:7, 113-131`

`http://127.0.0.1:9100` acepta POST `/print`, `/printers`, `/print-by-estacion`, `/test/{id}`, `DELETE /printers/{id}` sin ningún token, API key, ni origen check visible. Cualquier proceso corriendo en la PC del comerciante puede:
- Imprimir tickets falsos.
- Borrar configuración de impresoras (`/printers/${id}` DELETE).
- Loopear `/test` desperdiciando rollo.

Mitigación: el server vive solo en `127.0.0.1` (no expone afuera), entonces el riesgo es código local. Pero malware/extensión maliciosa lo aprovecha trivialmente.

Fix: el handshake con COMANDA debería ser:
1. Print server al arrancar genera un secret aleatorio guardado en `%LOCALAPPDATA%\comanda-printserver\token`.
2. Expose endpoint `GET /pair` que solo responde si el caller llega con `Origin: https://pase-comanda.vercel.app` (CORS strict + sin `Access-Control-Allow-Origin: *`).
3. COMANDA pide el token via `/pair`, lo guarda en localStorage por origen, lo manda como `X-Print-Token` en cada request.
4. Server valida `X-Print-Token` antes de operar.

### 🟠 6-8 AFIP gaps
- **6** (`afip-cae.js:140-144`): `Id: 5` = IVA 21%. Para gastronomía: carnicerías al 10.5%, exentos (panadería sin elaboración propia). Si un local del rubro emite Factura B con IVA 10.5%, AFIP rechaza. Fix: pasar el desglose IVA correcto desde el cliente o derivarlo de los items.
- **7** (`afip-cae.js:163-184`): para Factura A (tipo 1) AFIP exige que el receptor sea Responsable Inscripto y el CUIT debe matchear al Padrón. Hoy no se valida — si el cajero pone un CUIT cualquiera, AFIP rechaza con error genérico ("Datos invalidos") que es confuso. Fix: si `tipo_comprobante === 1`, validar formato CUIT (11 dígitos + check digit) antes de pedir CAE. Opcional: consultar Padrón AFIP via `wsAfipServicios` para evitar el roundtrip.
- **8** (`service.ts:96-153`): `parsearCertVencimiento` extrae fecha pero no se alerta en UI si está a <30 días. El cert AFIP vence cada 2 años. Sin alerta, el comerciante se entera el día que no puede facturar. Fix: panel `/integraciones/afip` con banner si `cert_vence_at - now() < 30 días`.

### 🟠 9-10 KDS / QR tokens + Realtime
- **9** (`kdsTokensService.ts:24-68`, `menuQrTokensService.ts:24-73`): tokens UUID v4 sin expiración. Una foto del QR de cocina (común en cocinas industriales con celulares "compartidos") sigue funcionando para siempre. Sin scope binding (IP/UA), un atacante con el token desde otra red ve todas las comandas del local en tiempo real. Fix mínimo: agregar `expires_at` (default `now() + interval '1 year'`) y rotación trimestral asistida desde admin. Mejor: bind a IP local (`192.168.*`) + intentar device fingerprint.
- **10** (`KdsView.tsx:11-13, 68-73`): el comentario afirma "los tickets nuevos van por Realtime ya (no por polling)" pero el componente solo llama `useVisiblePolling` cada 30s — NO hay `useRealtimeTable` ni `db.channel(...).on('postgres_changes', ...)`. Resultado real: el cocinero ve tickets nuevos con **hasta 30s de demora**, no en tiempo real como dice el comentario. Para una cocina con 100 tickets/h, 30s es la diferencia entre quedar al día y ahogarse.

### 🟠 11 — OAuth token cache en memoria por cold-start
`packages/pase/api/_rappi.js:28, 73`, `_pedidosya.js:24, 62`

`const _tokenCache = new Map()` a nivel módulo. En Vercel Functions:
- Si la function se mantiene "warm" (invocaciones <5min): cache reusado.
- Cold start (típico cada 10-15min en Hobby): nuevo token cada vez.

Rappi y PeYa rate-limitan tokens (típico 100/h). Si el tenant hace muchos `take/dispatch/cancel` y caés en cold starts, te quedás sin tokens y los partners empiezan a fallar 429.

Fix: cachear en tabla `oauth_tokens_cache` con TTL del `expires_in`, leer ahí primero, refresh on demand. Patrón ya usado por `get_mp_token` con `mp_credenciales.token_*`.

### 🟠 12-13 Partner webhook item matching + numero_local
- **12** (`tienda-mp.js:434-438`): `ilike '%${it.name}%'` matchea "Coca" con "Coca Cola", "Coca Zero", "Coca Light" → ambiguo. Sin sku_externo confiable, mejor crear `venta_pos_items` "open" con `precio_unitario` del partner y nombre literal — el cajero matchea manual antes de aprobar. Hoy se "saltan" items sin match, cliente espera comida que nunca llega.
- **13** (`tienda-mp.js:405`): `Math.floor(Date.now() / 1000) % 100000` — race con el contador del POS. Dos webhooks llegando en mismo segundo generan el mismo `numero_local`. Hay un RPC `fn_next_ticket_number_comanda` (comentario lo menciona) pero no se usa. Fix: usarla.

### 🟠 14 — `notificationUrl` hardcoded
`packages/pase/api/tienda-mp.js:167`
```js
const notificationUrl = `${SUPABASE_URL ? 'https://pase-yndx.vercel.app' : origin}/api/tienda-mp?action=webhook`;
```
Si COMANDA se despliega en dominio custom o preview deploy, MP webhook va siempre a `pase-yndx.vercel.app`. Funciona porque el handler está allá, pero acopla. Fix: `process.env.PUBLIC_API_URL`.

### 🟠 15 — Riders DoS via dbAnon
`packages/comanda/src/services/ridersService.ts:161-183`

`fn_actualizar_posicion_rider(p_rider_token, ...)` invocado vía anon key cada 30s. Sin rate limit, un script con el token (o fuerza bruta sobre UUIDs) puede:
- Llenar la tabla `rider_posiciones` con basura (write amplification).
- Mover el rider virtualmente a coordenadas absurdas, confundiendo el tracking público.

Mitigación parcial: el RPC valida el token. Pero sin throttle, miles de updates/seg son posibles. Fix: token + IP rate limit (Vercel Edge Middleware o policy en Postgres usando `pg_stat_statements`).

### 🟠 16 — `OR` filter injection latente
`packages/pase/api/tienda-mp.js:1206-1213, 1482-1489`
```js
.or(`sku_rappi.eq.${skuRappi},nombre.eq.${nombre}`)
```
`skuRappi` y `nombre` vienen del payload externo. Si contienen `,` o paréntesis, el parser de PostgREST `OR` falla con error 400. Fix: si contienen `,`, hacer dos queries separadas y unir client-side; o usar `.in('sku_rappi', [skuRappi]).or(\`nombre.eq.${nombre}\`)` con escape.

---

## Patrones cross-integraciones — observaciones

1. **No hay log unificado** tipo `ig_eventos`. AFIP errores en `afip_facturas.rechazo_motivo`; Rappi errores en `integraciones_externas_credenciales.last_error` (overwrite — perdés el histórico); webhooks delivery en `pedidos_externos_log` (tabla puede no existir — comentario dice "si la tabla no existe ignorar silenciosamente"). Sin lugar único, debugging cross-flow es por grep en Vercel logs. Recomendación: tabla `integraciones_eventos(tenant_id, provider, tipo_evento, severity, payload jsonb, error_msg, created_at)` append-only con retención 30 días.

2. **Retry/backoff inexistente**. Solo MP-sync (PASE) tiene cron + retries. Resto depende de:
   - El partner reintentando (Rappi/PeYa típicamente 3-5 veces con backoff).
   - El usuario reintentando manual (AFIP test connection, syncMenu).
   - Nada (notificaciones email tienda — si falla `resend.com` se pierde silenciosamente).

3. **CORS allow-list** — `afip-cae.js` usa `setCorsHeaders` (bien, fix auditoría previa). `tienda-mp.js` NO lo usa — los endpoints `notify-*`, `agent-heartbeat`, `cron-process-delivered` no setean CORS explícito. Para anon endpoints OK por Vercel default `*`, pero los `*-test` / `*-sync-menu` con JWT deberían tener allow-list. No es 🔴 porque la auth JWT cubre, pero es deuda consistente con F2 PASE.

4. **Naming inconsistente** — el módulo Rappi usa `take`, PeYa usa `accept` (espejo de las API reales, OK). Pero en `ConectarPartners.tsx` la card de Rappi linkea a `https://restaurants.rappi.com.ar` mientras que los docs reales están en `restaurantes` (con E). UX menor pero documentación rota.

5. **Tests faltantes**: solo encontré tests para `menuQrService`, `kdsService`, `escpos/printer`. No hay tests E2E o de integración para:
   - AFIP idempotency (caso recovery del 🔴 #2).
   - Webhook partner duplicate (🔴 #3).
   - MP webhook tenant resolution (🔴 #4).
   - Print agent revocation.
   - Rider token rotation.

   Considerando que AFIP, delivery webhooks y MP cobros mueven plata real, **mínimo deberían tener tests mutantes** según la regla del repo (CLAUDE.md). Hoy no los tienen.

## Recomendaciones de priorización (1 sprint)

1. **AFIP recovery** (🔴 #2) — reservar numero+request_uuid pre-AFIP, INSERT pendiente, después update. Test E2E mutante con kill-process simulado entre AFIP call y INSERT.
2. **HMAC firmas delivery + MP** (🔴 #1) — conectar los helpers ya escritos, leer `webhook_secret` de `credentials`. Apenas Lucas tenga la cred del partner real, activar.
3. **Idempotency webhook partner** (🔴 #3) — SELECT antes de INSERT por `(external_provider, external_order_id)`.
4. **MP webhook metadata** (🔴 #4) — agregar `metadata.mp_credencial_id` en preference, usarlo en webhook.
5. **Print server auth handshake** (🔴 #5) — token por origen, validación en server local. Coordinar con la app Electron del print agent (deuda fuera del repo).
6. **AFIP IVA + CUIT validation** (🟠 #6-7) — desglose IVA desde items + validate CUIT para tipo A.
7. **Token TTL + rotación KDS/QR** (🟠 #9) — `expires_at` column + UI para regenerar.
8. **KDS Realtime real** (🟠 #10) — agregar `useRealtimeTable({ table: 'kds_tickets' })` o cumplir lo que el comentario afirma.

El resto (🟡 / 🟢) es deuda incremental para los próximos 2-3 sprints.
